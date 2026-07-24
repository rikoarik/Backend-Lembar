/**
 * Plan HTTP routes (B6-01).
 *
 * GET /v1/me/plan — returns current workspace plan + usage
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import type { PlanService } from '../../application/PlanService.js';
import { ApiError } from '../../../../common/errors/envelope.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'req_unknown';
}

function getWorkspaceId(req: FastifyRequest, reply: FastifyReply): string | null {
  const wsId =
    (req.headers['x-workspace-id'] as string | undefined) ??
    (req.query as Record<string, string>)['workspaceId'];
  if (!wsId) {
    void reply.status(400).send({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Missing x-workspace-id header or workspaceId query param',
        requestId: getRequestId(req),
        retryable: false,
      },
    });
    return null;
  }
  return wsId;
}

function getTenantId(req: FastifyRequest, reply: FastifyReply): string | null {
  const tenantId = (req.headers['x-tenant-id'] as string | undefined);
  if (!tenantId) {
    void reply.status(400).send({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Missing x-tenant-id header',
        requestId: getRequestId(req),
        retryable: false,
      },
    });
    return null;
  }
  return tenantId;
}

function handleError(err: unknown, req: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof ApiError) {
    void reply.status(err.status).send(err.toEnvelope());
    return;
  }
  void reply.status(500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: getRequestId(req),
      retryable: false,
    },
  });
}

export async function registerPlanRoutes(
  app: FastifyInstance,
  service: PlanService,
): Promise<void> {
  /**
   * GET /v1/me/plan
   * Returns the current plan and usage for the authenticated workspace.
   */
  app.get('/v1/me/plan', async (request: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(request, reply);
    if (!workspaceId) return;
    const tenantId = getTenantId(request, reply);
    if (!tenantId) return;

    try {
      const summary = await service.getPlanSummary(tenantId, workspaceId);
      return reply.status(200).send({ data: summary });
    } catch (err) {
      handleError(err, request, reply);
    }
  });
}
