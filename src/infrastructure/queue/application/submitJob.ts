/**
 * BUG-19 — submit a job directly to a shared `QueueStore`.
 *
 * Extracted from `jobRoutes.ts` so the source-upload flow can enqueue its
 * `source_ingestion` job without going back out over HTTP. The idempotency
 * contract is unchanged: same key + same payload fingerprint → same job;
 * same key + different payload → `IdempotencyKeyReusedError`.
 */
import { randomUUID } from 'node:crypto';

import type { QueueStore, QueueStoreJob } from '../adapters/queue-store.js';
import type { JobKind, JobStatus } from '../persistence/schema.js';
import { IdempotencyKeyReusedError } from '../domain/errors.js';

export interface SubmitJobInput {
  workspaceId: string;
  actorId: string;
  kind: JobKind;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  quotaUnits: number;
  maxAttempts?: number;
}

export interface SubmitJobResult {
  jobId: string;
  workspaceId: string;
  actorId: string;
  kind: JobKind;
  status: JobStatus;
  duplicate: boolean;
  quotaReserved: number;
  reservationId: string;
}

export function stableFingerprint(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) return `[${value.map(stableFingerprint).join('|')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${key}=${stableFingerprint(obj[key])}`).join('|')}}`;
}

export async function submitJobToStore(
  store: QueueStore,
  input: SubmitJobInput,
): Promise<SubmitJobResult> {
  const fingerprint = stableFingerprint(input.payload);
  const existing = await store.getIdempotency({
    workspaceId: input.workspaceId,
    operation: input.kind,
    key: input.idempotencyKey,
  });
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new IdempotencyKeyReusedError();
    }
    const job = await store.getJob(existing.jobId);
    if (!job) throw new Error('missing job for idempotency record');
    return {
      jobId: job.id,
      workspaceId: job.workspaceId,
      actorId: job.actorId,
      kind: job.kind,
      status: job.status === 'created' ? 'queued' : job.status,
      duplicate: true,
      quotaReserved: job.quotaUnits,
      reservationId: existing.key,
    };
  }

  const reservationId = randomUUID();
  const jobInput: Omit<QueueStoreJob, 'createdAt' | 'updatedAt'> = {
    id: store.newId(),
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    kind: input.kind,
    status: 'queued',
    attempt: 0,
    maxAttempts: input.maxAttempts ?? 3,
    leaseTtlMs: 30_000,
    leaseExpiresAt: null,
    heartbeatAt: null,
    payload: input.payload,
    quotaUnits: input.quotaUnits,
    nextAttemptAt: null,
    lastError: null,
  };
  const job = await store.insertJob(jobInput);
  await store.insertIdempotency({
    key: input.idempotencyKey,
    workspaceId: input.workspaceId,
    operation: input.kind,
    jobId: job.id,
    fingerprint,
  });
  return {
    jobId: job.id,
    workspaceId: job.workspaceId,
    actorId: job.actorId,
    kind: job.kind,
    status: 'queued',
    duplicate: false,
    quotaReserved: input.quotaUnits,
    reservationId,
  };
}
