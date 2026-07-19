/**
 * Storage contract that both the in-memory test adapter and the Drizzle-backed
 * Postgres adapter satisfy. The `QueueSpike` facade is the only place that
 * talks to a store, so swapping the implementation does not leak.
 */
import type { JobKind, JobStatus } from '../persistence/schema.js';

export interface QueueStoreJob {
  id: string;
  workspaceId: string;
  actorId: string;
  kind: JobKind;
  status: JobStatus;
  attempt: number;
  maxAttempts: number;
  leaseTtlMs: number;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  payload: Record<string, unknown>;
  quotaUnits: number;
  nextAttemptAt: Date | null;
  lastError: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface QueueStoreClaimed extends QueueStoreJob {
  workerId: string;
}

export interface QueueStoreIdempotencyRecord {
  key: string;
  workspaceId: string;
  operation: string;
  jobId: string;
  fingerprint: string;
}

export interface QueueStore {
  insertJob(job: Omit<QueueStoreJob, 'createdAt' | 'updatedAt'>): Promise<QueueStoreJob>;
  getJob(id: string): Promise<QueueStoreJob | null>;
  getIdempotency(scope: {
    workspaceId: string;
    operation: string;
    key: string;
  }): Promise<QueueStoreIdempotencyRecord | null>;
  insertIdempotency(record: QueueStoreIdempotencyRecord): Promise<void>;
  nextClaimable(now: Date, excludeWorkspaceIds?: string[]): Promise<QueueStoreJob | null>;
  reserveClaim(
    id: string,
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<QueueStoreJob | null>;
  releaseClaim(id: string, workerId: string, now: Date): Promise<QueueStoreJob | null>;
  reapExpired(now: Date, safetyMarginMs: number): Promise<string[]>;
  heartbeat(
    id: string,
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<QueueStoreJob | null>;
  finalizeSuccess(id: string, workerId: string, now: Date): Promise<QueueStoreJob | null>;
  finalizeFailure(
    id: string,
    workerId: string,
    now: Date,
    error: unknown,
  ): Promise<QueueStoreJob | null>;
  rescheduleRetry(
    id: string,
    workerId: string,
    now: Date,
    nextAttemptAt: Date,
    attempt: number,
  ): Promise<QueueStoreJob | null>;
  markDeadLetter(
    id: string,
    workerId: string,
    now: Date,
    error: unknown,
  ): Promise<QueueStoreJob | null>;
  requestCancel(id: string, now: Date): Promise<QueueStoreJob | null>;
  auditRecover(
    id: string,
    now: Date,
    actorId: string,
    reason: string,
  ): Promise<QueueStoreJob | null>;
  queueDepth(now: Date): Promise<number>;
  auditEvents(): Promise<
    Array<{ action: string; jobId: string; actorId: string; at: Date; reason?: string }>
  >;
}
