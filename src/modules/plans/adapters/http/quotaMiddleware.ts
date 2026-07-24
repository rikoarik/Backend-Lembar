/**
 * Quota middleware (B6-01).
 *
 * Use as a preHandler hook on any generation route to enforce monthly limits.
 * Free plan: 10 generations/month. Pro plan: unlimited.
 *
 * Usage:
 *   app.post('/v1/assessments/:id/generate', {
 *     preHandler: createQuotaMiddleware(planService),
 *   }, handler);
 */
import type { FastifyRequest, FastifyReply } from 'fastify';

import type { PlanService } from '../../application/PlanService.js';
import { QuotaExceededError } from '../../domain/errors.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'req_unknown';
}

export function createQuotaMiddleware(planService: PlanService) {
  return async function quotaMiddleware(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const tenantId =
      (request.headers['x-tenant-id'] as string | undefined) ?? '';
    const wsId =
      (request.headers['x-workspace-id'] as string | undefined) ??
      (request.query as Record<string, string>)['workspaceId'] ??
      '';

    if (!tenantId || !wsId) {
      // Let route handler deal with missing workspace/tenant
      return;
    }

    try {
      await planService.assertQuota(tenantId, wsId);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        void reply.status(429).send({
          error: {
            code: 'RATE_LIMITED',
            message: `Monthly generation quota exceeded (${err.used}/${err.limit}). Upgrade to pro for unlimited generations.`,
            requestId: getRequestId(request),
            retryable: false,
          },
        });
        return;
      }
      throw err;
    }
  };
}
