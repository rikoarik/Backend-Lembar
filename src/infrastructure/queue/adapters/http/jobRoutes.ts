import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { parseQueueEnv } from '../../../../config/queue.env.js';
import { ApiError, type ErrorEnvelope } from '../../../../common/errors/envelope.js';
import { REQUEST_ID_HEADER } from '../../../../common/middleware/request-id.js';
import { InMemoryQueueStore } from '../memory-store.js';
import { QueueSpike } from '../../application/QueueSpike.js';
import type { SubmitInput } from '../../application/QueueSpike.js';
import { IdempotencyKeyReusedError } from '../../domain/errors.js';

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

export const registerJobRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const queueEnv = parseQueueEnv(process.env);
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
    const fieldErrors: Record<string, string[]> = {};
    if (!body.workspaceId) fieldErrors['workspaceId'] = ['required'];
    if (!body.actorId) fieldErrors['actorId'] = ['required'];
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
    try {
      const result = await spike.submit({
        workspaceId: body.workspaceId!,
        actorId: body.actorId!,
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
      throw err;
    }
  });

  // GET /v1/jobs/:jobId moved to B2-05 module (src/modules/jobs/adapters/http/routes.ts)
  // which provides neutral status mapping, tenant isolation, and cancel/recover endpoints.
};
