/**
 * Job status application service (B2-05).
 *
 * Orchestrates the end-to-end job lifecycle:
 * - Submits jobs through the queue with quota reservation
 * - Provides reload-safe neutral status views
 * - Handles cancel/retry with quota release
 * - Ensures tenant isolation on all operations
 * - Recovers from crash and lease-injection scenarios
 */
import type { QueueStoreJob } from '../../../infrastructure/queue/adapters/queue-store.js';
import type { QuotaLedger } from '../../quota/application/QuotaLedger.js';
import type {
  JobStatusView,
  JobSubmitInput,
  JobSubmitResult,
  TenantContext,
} from '../domain/types.js';
import { toNeutralStatus, toNeutralStage } from '../domain/status-mapper.js';
import {
  JobNotFoundError,
  JobTenantMismatchError,
  JobNotCancellableError,
} from '../domain/errors.js';

export interface JobStatusStore {
  getJob(id: string): Promise<QueueStoreJob | null>;
  submitJob(input: {
    workspaceId: string;
    actorId: string;
    kind: string;
    idempotencyKey: string;
    fingerprint: unknown;
    quotaUnits: number;
  }): Promise<{ job: QueueStoreJob; reservationId: string; duplicate: boolean }>;
  cancelJob(id: string, now: Date): Promise<QueueStoreJob | null>;
  requestRecover(id: string, actorId: string, reason: string): Promise<QueueStoreJob | null>;
}

export class JobStatusService {
  constructor(
    private readonly store: JobStatusStore,
    private readonly quotaLedger: QuotaLedger,
  ) {}

  /**
   * Submit a new job. Reserves quota, enqueues, returns neutral status.
   * Tenant isolation: job is scoped to the submitting tenant+workspace.
   */
  async submit(input: JobSubmitInput, tenantCtx: TenantContext): Promise<JobSubmitResult> {
    const { job, reservationId, duplicate } = await this.store.submitJob({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      fingerprint: input.fingerprint,
      quotaUnits: input.quotaUnits,
    });

    // Reserve quota in the ledger (unless duplicate)
    if (!duplicate) {
      await this.quotaLedger.reserve({
        tenantId: tenantCtx.tenantId,
        workspaceId: tenantCtx.workspaceId,
        jobId: job.id,
        idempotencyKey: input.idempotencyKey,
        units: input.quotaUnits,
      });
    }

    return {
      jobId: job.id,
      status: toNeutralStatus(job.status),
      duplicate,
      reservationId,
    };
  }

  /**
   * Get job status. Tenant isolation: returns 404 if job belongs to different tenant.
   */
  async getStatus(jobId: string, tenantCtx: TenantContext): Promise<JobStatusView> {
    const job = await this.store.getJob(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    // Tenant isolation: workspace must match
    if (job.workspaceId !== tenantCtx.workspaceId) {
      throw new JobTenantMismatchError(jobId, tenantCtx.workspaceId, job.workspaceId);
    }

    return this.toStatusView(job);
  }

  /**
   * Cancel a job. Releases quota reservation.
   * Tenant isolation: only the owning workspace can cancel.
   */
  async cancel(jobId: string, tenantCtx: TenantContext, _actorId: string): Promise<JobStatusView> {
    const job = await this.store.getJob(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    if (job.workspaceId !== tenantCtx.workspaceId) {
      throw new JobTenantMismatchError(jobId, tenantCtx.workspaceId, job.workspaceId);
    }

    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      throw new JobNotCancellableError(jobId, job.status);
    }

    const cancelled = await this.store.cancelJob(jobId, new Date());
    if (!cancelled) {
      throw new JobNotCancellableError(jobId, job.status);
    }

    // Release quota reservation
    const reservation = await this.quotaLedger.getReservationByJobId(jobId);
    if (reservation && reservation.state === 'reserved') {
      await this.quotaLedger.release(reservation.id, tenantCtx.tenantId);
    }

    return this.toStatusView(cancelled);
  }

  /**
   * Commit quota on job success. Called by the worker after successful processing.
   * Tenant isolation: verifies tenant ownership before committing.
   */
  async commitOnSuccess(jobId: string, tenantId: string): Promise<void> {
    const reservation = await this.quotaLedger.getReservationByJobId(jobId);
    if (reservation && reservation.state === 'reserved') {
      await this.quotaLedger.commit(reservation.id, tenantId);
    }
  }

  /**
   * Release quota on job failure. Called by the worker after terminal failure.
   * Tenant isolation: verifies tenant ownership before releasing.
   */
  async releaseOnFailure(jobId: string, tenantId: string): Promise<void> {
    const reservation = await this.quotaLedger.getReservationByJobId(jobId);
    if (reservation && reservation.state === 'reserved') {
      await this.quotaLedger.release(reservation.id, tenantId);
    }
  }

  /**
   * Manual recovery for dead-lettered jobs. Audited operation.
   * Tenant isolation: only the owning workspace can recover.
   */
  async recover(
    jobId: string,
    tenantCtx: TenantContext,
    actorId: string,
    reason: string,
  ): Promise<JobStatusView> {
    const job = await this.store.getJob(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    if (job.workspaceId !== tenantCtx.workspaceId) {
      throw new JobTenantMismatchError(jobId, tenantCtx.workspaceId, job.workspaceId);
    }

    const recovered = await this.store.requestRecover(jobId, actorId, reason);
    if (!recovered) {
      throw new JobNotFoundError(jobId);
    }

    return this.toStatusView(recovered);
  }

  /**
   * Get quota balance for a workspace.
   * Tenant isolation: scoped to tenant+workspace.
   */
  async getQuotaBalance(tenantCtx: TenantContext) {
    return this.quotaLedger.getBalance(tenantCtx.tenantId, tenantCtx.workspaceId);
  }

  private toStatusView(job: QueueStoreJob): JobStatusView {
    return {
      id: job.id,
      kind: job.kind,
      status: toNeutralStatus(job.status),
      stage: toNeutralStage(job.status, job.kind),
      progressCurrent: null,
      progressTotal: null,
      failureCode: job.lastError ? ((job.lastError as { code?: string }).code ?? null) : null,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
  }
}
