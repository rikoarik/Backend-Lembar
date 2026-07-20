/**
 * Adapter bridging the QueueStore to the JobStatusStore interface.
 *
 * Wraps the queue infrastructure to provide job submission, cancellation,
 * and recovery with proper idempotency and lease management.
 */
import type { QueueStore, QueueStoreJob } from '../../../infrastructure/queue/adapters/queue-store.js';
import type { JobKind } from '../../../infrastructure/queue/persistence/schema.js';
import { computeRequestFingerprint } from '../../../infrastructure/queue/policy/backoff.js';
import { fingerprint } from '../../../common/redact.js';
import type { JobStatusStore } from '../application/JobStatusService.js';

export interface QueueJobStatusAdapterOptions {
  leaseTtlMs: number;
  maxAttempts: number;
}

export class QueueJobStatusAdapter implements JobStatusStore {
  constructor(
    private readonly store: QueueStore,
    private readonly options: QueueJobStatusAdapterOptions,
    private readonly reservationIds = new Map<string, string>(),
  ) {}

  async getJob(id: string): Promise<QueueStoreJob | null> {
    return this.store.getJob(id);
  }

  async submitJob(input: {
    workspaceId: string;
    actorId: string;
    kind: string;
    idempotencyKey: string;
    fingerprint: unknown;
    quotaUnits: number;
  }): Promise<{ job: QueueStoreJob; reservationId: string; duplicate: boolean }> {
    const requestFingerprint = computeRequestFingerprint(input.fingerprint);

    // Check idempotency
    const existing = await this.store.getIdempotency({
      workspaceId: input.workspaceId,
      operation: input.kind,
      key: input.idempotencyKey,
    });

    if (existing) {
      const job = await this.store.getJob(existing.jobId);
      if (!job) throw new Error('Missing job for idempotency record');
      const reservationId = this.reservationIds.get(job.id) ?? '';
      return { job, reservationId, duplicate: true };
    }

    // Insert job
    const id = crypto.randomUUID();
    const job = await this.store.insertJob({
      id,
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      kind: input.kind as JobKind,
      status: 'queued',
      attempt: 0,
      maxAttempts: this.options.maxAttempts,
      leaseTtlMs: this.options.leaseTtlMs,
      leaseExpiresAt: null,
      heartbeatAt: null,
      payload: {
        idempotencyKeyFingerprint: fingerprint(input.idempotencyKey),
        requestFingerprint,
      },
      quotaUnits: input.quotaUnits,
      nextAttemptAt: null,
      lastError: null,
    });

    // Insert idempotency record
    await this.store.insertIdempotency({
      key: input.idempotencyKey,
      workspaceId: input.workspaceId,
      operation: input.kind,
      jobId: job.id,
      fingerprint: requestFingerprint,
    });

    const reservationId = crypto.randomUUID();
    this.reservationIds.set(job.id, reservationId);

    return { job, reservationId, duplicate: false };
  }

  async cancelJob(id: string, now: Date): Promise<QueueStoreJob | null> {
    return this.store.requestCancel(id, now);
  }

  async requestRecover(
    id: string,
    actorId: string,
    reason: string,
  ): Promise<QueueStoreJob | null> {
    return this.store.auditRecover(id, new Date(), actorId, reason);
  }
}
