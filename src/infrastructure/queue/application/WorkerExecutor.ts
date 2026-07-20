/**
 * Worker execution loop — claims jobs from queue, routes to handlers, manages leases.
 *
 * Responsibilities:
 * - Poll for claimable jobs respecting concurrency limits
 * - Route jobs to registered handlers
 * - Heartbeat active leases to prevent expiry
 * - Handle success/failure/retry outcomes
 * - Support graceful shutdown with lease cleanup
 */
import type { QueueStore, QueueStoreJob } from '../adapters/queue-store.js';
import type { JobHandlerRegistry, JobContext, JobResult } from '../domain/JobHandler.js';

export interface WorkerExecutorOptions {
  workerId: string;
  concurrency: number;
  pollIntervalMs: number;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  shutdownGracePeriodMs: number;
}

interface ActiveJob {
  job: QueueStoreJob;
  controller: AbortController;
  heartbeatTimer: NodeJS.Timeout;
}

export class WorkerExecutor {
  private readonly store: QueueStore;
  private readonly registry: JobHandlerRegistry;
  private readonly options: WorkerExecutorOptions;
  private readonly activeJobs = new Map<string, ActiveJob>();
  private pollTimer: NodeJS.Timeout | null = null;
  private running = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(store: QueueStore, registry: JobHandlerRegistry, options: WorkerExecutorOptions) {
    this.store = store;
    this.registry = registry;
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Worker already running');
    }
    this.running = true;
    this.schedulePoll();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Abort all active jobs
    for (const active of this.activeJobs.values()) {
      active.controller.abort();
      clearInterval(active.heartbeatTimer);
    }

    // Wait for active jobs to complete or timeout
    const deadline = Date.now() + this.options.shutdownGracePeriodMs;
    while (this.activeJobs.size > 0 && Date.now() < deadline) {
      await this.sleep(100);
    }

    // Force release remaining leases
    const now = new Date();
    for (const [jobId] of this.activeJobs) {
      try {
        await this.store.releaseClaim(jobId, this.options.workerId, now);
      } catch (err) {
        console.error(`Failed to release lease for job ${jobId}:`, err);
      }
    }

    this.activeJobs.clear();
  }

  private schedulePoll(): void {
    if (!this.running) return;

    this.pollTimer = setTimeout(() => {
      this.poll().catch((err) => {
        console.error('Poll failed:', err);
        this.schedulePoll();
      });
    }, this.options.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    try {
      // Check concurrency limit
      if (this.activeJobs.size >= this.options.concurrency) {
        this.schedulePoll();
        return;
      }

      // Get workspace IDs currently being processed
      const busyWorkspaces = Array.from(this.activeJobs.values()).map((a) => a.job.workspaceId);

      // Claim next available job
      const now = new Date();
      const claimable = await this.store.nextClaimable(now, busyWorkspaces);

      if (!claimable) {
        this.schedulePoll();
        return;
      }

      // Reserve the job
      const claimed = await this.store.reserveClaim(
        claimable.id,
        this.options.workerId,
        now,
        this.options.leaseTtlMs,
      );

      if (!claimed) {
        // Someone else claimed it
        this.schedulePoll();
        return;
      }

      // Execute the job
      await this.execute(claimed);
    } finally {
      this.schedulePoll();
    }
  }

  private async execute(job: QueueStoreJob): Promise<void> {
    const handler = this.registry.get(job.kind);
    if (!handler) {
      console.error(`No handler registered for job kind: ${job.kind}`);
      await this.store.finalizeFailure(job.id, this.options.workerId, new Date(), {
        code: 'NO_HANDLER',
        message: `No handler registered for kind: ${job.kind}`,
      });
      return;
    }

    const controller = new AbortController();
    const heartbeatTimer = this.startHeartbeat(job.id);

    this.activeJobs.set(job.id, {
      job,
      controller,
      heartbeatTimer,
    });

    try {
      const context: JobContext = {
        jobId: job.id,
        workspaceId: job.workspaceId,
        actorId: job.actorId,
        attempt: job.attempt,
        payload: job.payload,
        signal: controller.signal,
      };

      const result = await handler.handle(context);
      await this.handleResult(job, result);
    } catch (err) {
      await this.handleError(job, err);
    } finally {
      clearInterval(heartbeatTimer);
      this.activeJobs.delete(job.id);
    }
  }

  private async handleResult(job: QueueStoreJob, result: JobResult): Promise<void> {
    const now = new Date();

    if (result.status === 'success') {
      await this.store.finalizeSuccess(job.id, this.options.workerId, now);
    } else if (result.status === 'partial') {
      // Partial success - decide based on error code if present
      if (result.error?.code) {
        await this.handleRetry(job, result.error);
      } else {
        await this.store.finalizeSuccess(job.id, this.options.workerId, now);
      }
    } else {
      // Failure
      await this.handleRetry(job, result.error ?? { code: 'UNKNOWN', message: 'Job failed' });
    }
  }

  private async handleError(job: QueueStoreJob, err: unknown): Promise<void> {
    const error = {
      code: 'HANDLER_ERROR',
      message: err instanceof Error ? err.message : String(err),
      details: err,
    };

    await this.handleRetry(job, error);
  }

  private async handleRetry(
    job: QueueStoreJob,
    error: { code: string; message: string; details?: unknown },
  ): Promise<void> {
    const now = new Date();

    // Simple retry logic - can be enhanced with backoff
    if (job.attempt < job.maxAttempts) {
      const nextAttempt = new Date(now.getTime() + this.computeBackoff(job.attempt));
      await this.store.rescheduleRetry(
        job.id,
        this.options.workerId,
        now,
        nextAttempt,
        job.attempt + 1,
      );
    } else {
      await this.store.markDeadLetter(job.id, this.options.workerId, now, error);
    }
  }

  private computeBackoff(attempt: number): number {
    // Exponential backoff: 500ms * 2^attempt, max 30s
    return Math.min(30_000, 500 * 2 ** attempt);
  }

  private startHeartbeat(jobId: string): NodeJS.Timeout {
    return setInterval(async () => {
      try {
        const now = new Date();
        await this.store.heartbeat(jobId, this.options.workerId, now, this.options.leaseTtlMs);
      } catch (err) {
        console.error(`Heartbeat failed for job ${jobId}:`, err);
      }
    }, this.options.heartbeatIntervalMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Metrics
  getActiveJobCount(): number {
    return this.activeJobs.size;
  }

  isRunning(): boolean {
    return this.running;
  }
}
