/**
 * B5-01 — HTTP routes for print document.
 *
 * Endpoints:
 *   GET /v1/assessments/:id/print — returns versioned PrintDocument DTO
 *
 * Tenant isolation: workspaceId extracted from authenticated context header.
 * The route does NOT require authentication middleware here — the caller
 * (app.ts) is responsible for attaching workspace context.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { ApiError, buildErrorEnvelope } from '../../../../common/errors/envelope.js';
import type { PrintService } from '../../application/PrintService.js';

function getRequestId(request: FastifyRequest): string {
  return (request.headers['x-request-id'] as string | undefined) ?? 'unknown';
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

export async function registerPrintRoutes(
  app: FastifyInstance,
  service: PrintService,
): Promise<void> {
  /**
   * GET /v1/assessments/:id/print
   *
   * Returns the PrintDocument DTO for a finalized assessment.
   * workspaceId must be provided via x-workspace-id header (same pattern as other routes).
   */
  app.get(
    '/v1/assessments/:id/print',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const requestId = getRequestId(request);

      const workspaceId = request.headers['x-workspace-id'] as string | undefined;
      if (!workspaceId) {
        return reply.status(400).send(
          buildErrorEnvelope({
            code: 'VALIDATION_FAILED',
            message: 'x-workspace-id header is required',
            requestId,
          }),
        );
      }

      try {
        const doc = await service.buildPrintDocument(workspaceId, id, requestId);
        return reply.status(200).send({ data: doc });
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );
}
