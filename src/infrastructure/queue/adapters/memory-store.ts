import { randomUUID } from 'node:crypto';

import type { QueueStore, QueueStoreIdempotencyRecord, QueueStoreJob } from './queue-store.js';

interface AuditEvent {
  action: string;
  jobId: string;
  actorId: string;
  at: Date;
  reason?: string;
}

/** Max completed/dead-letter jobs to retain before the oldest are evicted. */
const MAX_COMPLETED_JOBS = 500;

/** Max audit events to retain in the ring buffer. */
const MAX_AUDIT_EVENTS = 1_000;

export class InMemoryQueueStore implements QueueStore {
  private readonly jobs = new Map<string, QueueStoreJob>();
  private readonly workers = new Map<string, string>();
  private readonly idem = new Map<string, QueueStoreIdempotencyRecord>();
  private readonly audit: AuditEvent[] = [];

  /**
   * Evict oldest terminal-state jobs once the completed set exceeds the cap.
   * Only removes `succeeded`, `failed`, and `dead_letter` entries — never
   * anything that is still queued, running, or waiting for retry.
   */
  private evictCompletedJobs(): void {
    const terminal = [...this.jobs.values()].filter(
      (j) =>
        j.status === 'succeeded' ||
        j.status === 'failed' ||
        j.status === 'partially_succeeded' ||
        j.status === 'cancelled',
    );
    if (terminal.length <= MAX_COMPLETED_JOBS) return;
    // Sort oldest-first and remove the excess
    terminal.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
    const toRemove = terminal.slice(0, terminal.length - MAX_COMPLETED_JOBS);
    for (const job of toRemove) {
      this.jobs.delete(job.id);
    }
  }

  /** Trim audit ring buffer to MAX_AUDIT_EVENTS most-recent entries. */
  private trimAudit(): void {
    if (this.audit.length > MAX_AUDIT_EVENTS) {
      this.audit.splice(0, this.audit.length - MAX_AUDIT_EVENTS);
    }
  }

  async insertJob(job: Omit<QueueStoreJob, 'createdAt' | 'updatedAt'>): Promise<QueueStoreJob> {
    const now = new Date();
    const stored: QueueStoreJob = { ...job, createdAt: now, updatedAt: now };
    this.jobs.set(stored.id, stored);
    return stored;
  }

  async getJob(id: string): Promise<QueueStoreJob | null> {
    return this.jobs.get(id) ?? null;
  }

  getJobSync(id: string): QueueStoreJob | null {
    return this.jobs.get(id) ?? null;
  }

  listJobs(): QueueStoreJob[] {
    return [...this.jobs.values()];
  }

  async getIdempotency(scope: {
    workspaceId: string;
    operation: string;
    key: string;
  }): Promise<QueueStoreIdempotencyRecord | null> {
    return this.idem.get(this.idemKey(scope.workspaceId, scope.operation, scope.key)) ?? null;
  }

  async insertIdempotency(record: QueueStoreIdempotencyRecord): Promise<void> {
    this.idem.set(this.idemKey(record.workspaceId, record.operation, record.key), record);
  }

  async nextClaimable(
    now: Date,
    excludeWorkspaceIds: string[] = [],
  ): Promise<QueueStoreJob | null> {
    const blocked = new Set(excludeWorkspaceIds);
    return (
      this.listJobs()
        .filter((job) => job.status === 'queued')
        .filter((job) => !blocked.has(job.workspaceId))
        .filter((job) => !job.nextAttemptAt || job.nextAttemptAt.getTime() <= now.getTime())
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null
    );
  }

  async reserveClaim(
    id: string,
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<QueueStoreJob | null> {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'queued') return null;
    if (job.nextAttemptAt && job.nextAttemptAt.getTime() > now.getTime()) return null;
    const claimed: QueueStoreJob = {
      ...job,
      status: 'running',
      attempt: job.attempt + 1,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      heartbeatAt: now,
      updatedAt: now,
    };
    this.jobs.set(id, claimed);
    this.workers.set(id, workerId);
    return claimed;
  }

  async releaseClaim(id: string, workerId: string, now: Date): Promise<QueueStoreJob | null> {
    const job = this.jobs.get(id);
    if (!job || this.workers.get(id) !== workerId) return null;
    const released: QueueStoreJob = {
      ...job,
      status: 'queued',
      leaseExpiresAt: null,
      heartbeatAt: null,
      updatedAt: now,
    };
    this.jobs.set(id, released);
    this.workers.delete(id);
    return released;
  }

  async reapExpired(now: Date, safetyMarginMs: number): Promise<string[]> {
    const reaped: string[] = [];
    for (const job of this.listJobs()) {
      if (job.status !== 'running' || !job.leaseExpiresAt) continue;
      if (job.leaseExpiresAt.getTime() + safetyMarginMs > now.getTime()) continue;
      const released: QueueStoreJob = {
        ...job,
        status: 'queued',
        leaseExpiresAt: null,
        heartbeatAt: null,
        updatedAt: now,
      };
      this.jobs.set(job.id, released);
      this.workers.delete(job.id);
      reaped.push(job.id);
    }
    return reaped;
  }

  async heartbeat(
    id: string,
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<QueueStoreJob | null> {
    const job = this.jobs.get(id);
    if (!job || this.workers.get(id) !== workerId || job.status !== 'running') return null;
    const updated: QueueStoreJob = {
      ...job,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      heartbeatAt: now,
      updatedAt: now,
    };
    this.jobs.set(id, updated);
    return updated;
  }

  async finalizeSuccess(id: string, workerId: string, now: Date): Promise<QueueStoreJob | null> {
    return this.finish(id, workerId, now, 'succeeded');
  }

  async finalizeFailure(
    id: string,
    workerId: string,
    now: Date,
    error: unknown,
  ): Promise<QueueStoreJob | null> {
    return this.finish(id, workerId, now, 'failed', error);
  }

  async rescheduleRetry(
    id: string,
    workerId: string,
    now: Date,
    nextAttemptAt: Date,
    attempt: number,
  ): Promise<QueueStoreJob | null> {
    const job = this.jobs.get(id);
    if (!job || this.workers.get(id) !== workerId || job.status !== 'running') return null;
    const retried: QueueStoreJob = {
      ...job,
      status: 'retry_wait',
      attempt,
      nextAttemptAt,
      leaseExpiresAt: null,
      heartbeatAt: null,
      updatedAt: now,
    };
    this.jobs.set(id, retried);
    this.workers.delete(id);
    return retried;
  }

  async markDeadLetter(
    id: string,
    workerId: string,
    now: Date,
    error: unknown,
  ): Promise<QueueStoreJob | null> {
    return this.finish(id, workerId, now, 'failed', error);
  }

  async requestCancel(id: string, now: Date): Promise<QueueStoreJob | null> {
    const job = this.jobs.get(id);
    if (!job || ['succeeded', 'failed', 'cancelled'].includes(job.status)) return null;
    const cancelled: QueueStoreJob = {
      ...job,
      status: 'cancelled',
      leaseExpiresAt: null,
      heartbeatAt: null,
      updatedAt: now,
    };
    this.jobs.set(id, cancelled);
    this.workers.delete(id);
    return cancelled;
  }

  async updateJobProgress(
    id: string,
    progressCurrent: number,
    progressTotal: number,
    now: Date,
  ): Promise<QueueStoreJob | null> {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return null;
    const updated: QueueStoreJob = {
      ...job,
      payload: { ...job.payload, progressCurrent, progressTotal },
      updatedAt: now,
    };
    this.jobs.set(id, updated);
    return updated;
  }

  async auditRecover(
    id: string,
    now: Date,
    actorId: string,
    reason: string,
  ): Promise<QueueStoreJob | null> {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'failed') return null;
    const recovered: QueueStoreJob = {
      ...job,
      status: 'queued',
      nextAttemptAt: now,
      leaseExpiresAt: null,
      heartbeatAt: null,
      updatedAt: now,
      lastError: null,
    };
    this.jobs.set(id, recovered);
    this.audit.push({ action: 'manual_recover', jobId: id, actorId, at: now, reason });
    return recovered;
  }

  async queueDepth(now: Date): Promise<number> {
    return this.listJobs().filter(
      (job) =>
        job.status === 'queued' &&
        (!job.nextAttemptAt || job.nextAttemptAt.getTime() <= now.getTime()),
    ).length;
  }

  async auditEvents(): Promise<AuditEvent[]> {
    return [...this.audit];
  }

  auditEventsSync(): AuditEvent[] {
    return [...this.audit];
  }

  releaseRetryWait(now: Date): void {
    for (const job of this.listJobs()) {
      if (job.status !== 'retry_wait') continue;
      this.jobs.set(job.id, {
        ...job,
        status: 'queued',
        nextAttemptAt: now,
        updatedAt: now,
      });
    }
  }

  newId(): string {
    return randomUUID();
  }

  private idemKey(workspaceId: string, operation: string, key: string): string {
    return `${workspaceId}::${operation}::${key}`;
  }

  private finish(
    id: string,
    workerId: string,
    now: Date,
    status: 'succeeded' | 'failed',
    lastError: unknown = null,
  ): QueueStoreJob | null {
    const job = this.jobs.get(id);
    if (!job || this.workers.get(id) !== workerId) return null;
    const done: QueueStoreJob = {
      ...job,
      status,
      leaseExpiresAt: null,
      heartbeatAt: null,
      updatedAt: now,
      lastError,
    };
    this.jobs.set(id, done);
    this.workers.delete(id);
    // Evict oldest terminal jobs so the Map doesn't grow without bound.
    this.evictCompletedJobs();
    return done;
  }
}
