import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { parseQueueEnv } from '../../../../config/queue.env.js';
import { ApiError, type ErrorEnvelope } from '../../../../common/errors/envelope.js';
import { REQUEST_ID_HEADER } from '../../../../common/middleware/request-id.js';
import { InMemoryQueueStore } from '../memory-store.js';
import { QueueSpike } from '../../application/QueueSpike.js';
import type { SubmitInput } from '../../application/QueueSpike.js';
import type { QueueStore, QueueStoreJob } from '../queue-store.js';
import type { JobStatus } from '../../persistence/schema.js';
import { IdempotencyKeyReusedError } from '../../domain/errors.js';
import { authenticateWithDb } from '../../../../common/middleware/authenticateWithDb.js';
import { QuotaExceededError } from '../../../../modules/plans/domain/errors.js';

interface SubmitBody {
  workspaceId?: string;
  actorId?: string;
  operation?: SubmitInput['operation'];
  idempotencyKey?: string;
  payload?: unknown;
  quotaUnits?: number;
}

function badRequest(
  requestId: string,
  code: 'VALIDATION_FAILED',
  message: string,
  fieldErrors: Record<string, readonly string[]>,
): ErrorEnvelope {
  const envelope = new ApiError({ code, message, requestId, status: 400, fieldErrors });
  return envelope.toEnvelope();
}

export interface RegisterJobRoutesOptions {
  /**
   * Shared queue store. When omitted we fall back to an in-process
   * `InMemoryQueueStore` (B0-06 spike behaviour). Production wiring injects
   * the same Postgres store the worker reads from so submissions and
   * claims see each other across processes.
   */
  store?: QueueStore;
}

export interface GenerationAccess {
  assertGenerationAllowed(input: {
    tenantId: string;
    workspaceId: string;
    userId: string;
    deviceToken?: string;
  }): Promise<void>;
}

interface SubmitViaStoreInput {
  workspaceId: string;
  actorId: string;
  operation: SubmitInput['operation'];
  idempotencyKey: string;
  payload: Record<string, unknown>;
  quotaUnits: number;
}

interface SubmitViaStoreResult {
  jobId: string;
  workspaceId: string;
  actorId: string;
  kind: SubmitInput['operation'];
  status: JobStatus;
  duplicate: boolean;
  quotaReserved: number;
  reservationId: string;
}

/**
 * Submit a job to a shared `QueueStore` while preserving the idempotency
 * contract the legacy `QueueSpike` exposes (same fingerprint → same job,
 * different fingerprint → 409).
 */
async function submitToSharedStore(
  store: QueueStore,
  input: SubmitViaStoreInput,
): Promise<SubmitViaStoreResult> {
  const fingerprint = stableFingerprint(input.payload);
  const existing = await store.getIdempotency({
    workspaceId: input.workspaceId,
    operation: input.operation,
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
    kind: input.operation,
    status: 'queued',
    attempt: 0,
    maxAttempts: 3,
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
    operation: input.operation,
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

function stableFingerprint(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) return `[${value.map(stableFingerprint).join('|')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${key}=${stableFingerprint(obj[key])}`).join('|')}}`;
}

export const registerJobRoutes: FastifyPluginAsync<{
  Store?: QueueStore;
  jwtSecret?: string;
  db?: import('../../../../infrastructure/database/db.js').Database | undefined;
  generationAccess?: GenerationAccess;
}> = async (app: FastifyInstance, options) => {
  const queueEnv = parseQueueEnv(process.env);
  const sharedStore: QueueStore | null = options?.Store ?? null;
  const jwtSecret =
    options.jwtSecret ?? process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  const spike = new QueueSpike(new InMemoryQueueStore(), {
    leaseTtlMs: queueEnv.leaseTtlMs,
    leaseSafetyMarginMs: queueEnv.leaseSafetyMarginMs,
    maxAttempts: queueEnv.maxAttempts,
    backoffBaseMs: queueEnv.backoffBaseMs,
    backoffMaxMs: queueEnv.backoffMaxMs,
    workerConcurrency: queueEnv.workerConcurrency,
    perWorkspaceConcurrency: queueEnv.perWorkspaceConcurrency,
    perWorkspaceRateLimit: queueEnv.perWorkspaceRateLimit,
    depthAlertThreshold: queueEnv.depthAlertThreshold,
  });

  app.post('/v1/jobs', async (req, reply) => {
    const body = (req.body ?? {}) as SubmitBody;
    const requestId = req.requestId ?? 'req_unknown';
    let auth;
    try {
      auth = await authenticateWithDb(req, { secret: jwtSecret, ...(options.db ? { db: options.db } : {}) });
    } catch (err) {
      if (err instanceof ApiError) {
        const envelope = new ApiError({
          code: err.code,
          message: err.message,
          requestId,
          status: err.status,
        }).toEnvelope();
        void reply.header(REQUEST_ID_HEADER, requestId).status(err.status).send(envelope);
        return;
      }
      throw err;
    }

    const fieldErrors: Record<string, string[]> = {};
    if (!auth.workspaceId) fieldErrors['workspaceId'] = ['JWT workspace diperlukan'];
    if (!body.operation) fieldErrors['operation'] = ['required'];
    if (!body.idempotencyKey) fieldErrors['idempotencyKey'] = ['required'];
    if (Object.keys(fieldErrors).length > 0) {
      const envelope = badRequest(
        requestId,
        'VALIDATION_FAILED',
        'Permintaan tidak valid.',
        fieldErrors,
      );
      void reply.header(REQUEST_ID_HEADER, requestId).status(400).send(envelope);
      return;
    }
    if (body.workspaceId && body.workspaceId !== auth.workspaceId) {
      const envelope = new ApiError({
        code: 'PERMISSION_DENIED',
        message: 'Workspace permintaan tidak sesuai dengan workspace akun.',
        requestId,
        status: 403,
      }).toEnvelope();
      void reply.header(REQUEST_ID_HEADER, requestId).status(403).send(envelope);
      return;
    }

    const workspaceId = auth.workspaceId!;
    const actorId = auth.userId;
    try {
      if (body.operation === 'assessment_generation') {
        if (!options.generationAccess)
          throw new Error('generation access service is not configured');
        const existing = sharedStore
          ? await sharedStore.getIdempotency({
              workspaceId,
              operation: body.operation,
              key: body.idempotencyKey!,
            })
          : null;
        if (!existing) {
          const deviceToken = req.headers['x-trial-device-token'];
          await options.generationAccess.assertGenerationAllowed({
            tenantId: workspaceId,
            workspaceId,
            userId: actorId,
            ...(typeof deviceToken === 'string' ? { deviceToken } : {}),
          });
        }
      }

      const result = sharedStore
        ? await submitToSharedStore(sharedStore, {
            workspaceId,
            actorId,
            operation: body.operation!,
            idempotencyKey: body.idempotencyKey!,
            payload: (body.payload ?? {}) as Record<string, unknown>,
            quotaUnits: body.quotaUnits ?? 1,
          })
        : await spike.submit({
            workspaceId,
            actorId,
            operation: body.operation!,
            idempotencyKey: body.idempotencyKey!,
            fingerprint: body.payload ?? {},
            quotaUnits: body.quotaUnits ?? 1,
          });
      const status = result.duplicate ? 200 : 202;
      void reply.header(REQUEST_ID_HEADER, requestId).status(status).send(result);
    } catch (err) {
      if (err instanceof IdempotencyKeyReusedError) {
        const envelope = new ApiError({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Idempotency-Key sudah dipakai dengan payload berbeda.',
          requestId,
          status: 409,
        }).toEnvelope();
        void reply.header(REQUEST_ID_HEADER, requestId).status(409).send(envelope);
        return;
      }
      if (err instanceof QuotaExceededError) {
        const envelope = new ApiError({
          code: 'RATE_LIMITED',
          message: `Kuota pembuatan soal bulanan habis (${err.used}/${err.limit}). Tingkatkan ke Pro untuk melanjutkan.`,
          requestId,
          status: 429,
        }).toEnvelope();
        void reply.header(REQUEST_ID_HEADER, requestId).status(429).send(envelope);
        return;
      }
      throw err;
    }
  });

  // GET /v1/jobs/:jobId moved to B2-05 module (src/modules/jobs/adapters/http/routes.ts)
  // which provides neutral status mapping, tenant isolation, and cancel/recover endpoints.
};
