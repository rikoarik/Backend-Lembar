/**
 * B5-04 — HTTP routes for history and private question bank.
 *
 * Endpoints:
 *   GET /v1/history                    — paginated assessment history, tenant-scoped
 *   GET /v1/history/:assessmentId      — assessment detail with question snapshots
 *   GET /v1/bank/questions             — saved questions per tenant (paginated)
 *
 * Tenant isolation: workspaceId from x-workspace-id header.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { ApiError, buildErrorEnvelope } from '../../../../common/errors/envelope.js';
import type { HistoryService } from '../../application/HistoryService.js';

function getRequestId(request: FastifyRequest): string {
  return (request.headers['x-request-id'] as string | undefined) ?? 'unknown';
}

function getWorkspaceId(request: FastifyRequest, reply: FastifyReply): string | null {
  const wsId = request.headers['x-workspace-id'] as string | undefined;
  if (!wsId) {
    reply.status(400).send(
      buildErrorEnvelope({
        code: 'VALIDATION_FAILED',
        message: 'x-workspace-id header is required',
        requestId: getRequestId(request),
      }),
    );
    return null;
  }
  return wsId;
}

function handleError(err: unknown, request: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof ApiError) {
    reply.status(err.status).send(err.toEnvelope());
    return;
  }
  reply.status(500).send(
    buildErrorEnvelope({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: getRequestId(request),
    }),
  );
}

export async function registerHistoryRoutes(
  app: FastifyInstance,
  service: HistoryService,
): Promise<void> {
  /**
   * GET /v1/history
   * Paginated assessment history for the requesting workspace.
   * Query params: limit (default 20, max 100), cursor (last seen assessment ID)
   */
  app.get('/v1/history', async (request: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(request, reply);
    if (!workspaceId) return;

    const query = request.query as { limit?: string; cursor?: string };
    const limit = Math.min(parseInt(query.limit ?? '20', 10) || 20, 100);

    try {
      const page = await service.listHistory(
        workspaceId,
        limit,
        query.cursor,
      );
      return reply.status(200).send({ data: page });
    } catch (err) {
      handleError(err, request, reply);
    }
  });

  /**
   * GET /v1/history/:assessmentId
   * Assessment detail with immutable question snapshots.
   */
  app.get(
    '/v1/history/:assessmentId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const workspaceId = getWorkspaceId(request, reply);
      if (!workspaceId) return;

      const { assessmentId } = request.params as { assessmentId: string };

      try {
        const detail = await service.getAssessmentDetail(
          workspaceId,
          assessmentId,
          getRequestId(request),
        );
        return reply.status(200).send({ data: detail });
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );

  /**
   * GET /v1/bank/questions
   * Private question bank for the requesting workspace.
   * Query params: limit (default 20, max 100), after (cursor: offset index as string)
   */
  app.get('/v1/bank/questions', async (request: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(request, reply);
    if (!workspaceId) return;

    const query = request.query as { limit?: string; after?: string };
    const limit = Math.min(parseInt(query.limit ?? '20', 10) || 20, 100);
    const afterIndex = parseInt(query.after ?? '0', 10) || 0;

    try {
      const page = await service.listBank(workspaceId, limit, afterIndex);
      return reply.status(200).send({ data: page });
    } catch (err) {
      handleError(err, request, reply);
    }
  });
}
