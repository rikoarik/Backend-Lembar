/**
 * B5-02 — HTTP routes for PDF artifact lifecycle.
 *
 * Endpoints:
 *   POST /v1/assessments/:id/output — trigger render/store artifact (idempotent)
 *   GET  /v1/assessments/:id/output — returns download URL or artifact info
 *
 * Tenant isolation: workspaceId from x-workspace-id header.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { ApiError, buildErrorEnvelope } from '../../../../common/errors/envelope.js';
import type { PrintArtifactService } from '../../application/PrintArtifactService.js';

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

export async function registerArtifactRoutes(
  app: FastifyInstance,
  service: PrintArtifactService,
): Promise<void> {
  /**
   * POST /v1/assessments/:id/output
   * Trigger render. Idempotent: same HTML content → same artifact (no re-render).
   */
  app.post(
    '/v1/assessments/:id/output',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const workspaceId = getWorkspaceId(request, reply);
      if (!workspaceId) return;

      const { id } = request.params as { id: string };

      try {
        const result = await service.triggerRender(workspaceId, id, getRequestId(request));
        return reply.status(result.reused ? 200 : 201).send({
          data: {
            artifact: {
              id: result.artifact.id,
              status: result.artifact.status,
              contentType: result.artifact.contentType,
              byteSize: result.artifact.byteSize,
              contentHash: result.artifact.contentHash,
              createdAt: result.artifact.createdAt,
            },
            reused: result.reused,
          },
        });
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );

  /**
   * GET /v1/assessments/:id/output
   * Returns artifact info + short-lived signed download URL.
   */
  app.get(
    '/v1/assessments/:id/output',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const workspaceId = getWorkspaceId(request, reply);
      if (!workspaceId) return;

      const { id } = request.params as { id: string };

      try {
        const result = await service.getArtifactInfo(workspaceId, id, getRequestId(request));
        return reply.status(200).send({
          data: {
            artifact: {
              id: result.artifact.id,
              status: result.artifact.status,
              contentType: result.artifact.contentType,
              byteSize: result.artifact.byteSize,
              contentHash: result.artifact.contentHash,
              createdAt: result.artifact.createdAt,
            },
            downloadUrl: result.downloadUrl,
            expiresAtEpochMs: result.expiresAtEpochMs,
          },
        });
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );
}
