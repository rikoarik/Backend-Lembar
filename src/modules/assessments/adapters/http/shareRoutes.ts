/**
 * B5-03 — HTTP routes for controlled share links.
 *
 * Endpoints:
 *   POST   /v1/shares                    — create share link (tenant-scoped)
 *   GET    /v1/shares/:token             — public access, validate token + expiry
 *   DELETE /v1/shares/:token/revoke      — revoke share link (owner only)
 *
 * Tenant isolation: workspaceId from x-workspace-id header.
 * Public endpoint (GET) does not require workspace header.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { ApiError, buildErrorEnvelope } from '../../../../common/errors/envelope.js';
import type { ShareLinkService } from '../../application/ShareLinkService.js';

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

interface CreateShareBody {
  assessmentId: string;
  ttlSeconds?: number;
}

export async function registerShareRoutes(
  app: FastifyInstance,
  service: ShareLinkService,
): Promise<void> {
  /**
   * POST /v1/shares
   * Create share link with expiry TTL and high-entropy token.
   * Requires x-workspace-id header.
   */
  app.post('/v1/shares', async (request: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(request, reply);
    if (!workspaceId) return;

    const body = request.body as CreateShareBody | undefined;
    if (!body?.assessmentId) {
      return reply.status(400).send(
        buildErrorEnvelope({
          code: 'VALIDATION_FAILED',
          message: 'assessmentId is required',
          requestId: getRequestId(request),
        }),
      );
    }

    try {
      const link = await service.createShareLink({
        workspaceId,
        assessmentId: body.assessmentId,
        requestId: getRequestId(request),
        ...(body.ttlSeconds !== undefined ? { ttlSeconds: body.ttlSeconds } : {}),
      });
      return reply.status(201).send({
        data: {
          id: link.id,
          token: link.token,
          assessmentId: link.assessmentId,
          expiresAt: link.expiresAt,
          createdAt: link.createdAt,
        },
      });
    } catch (err) {
      handleError(err, request, reply);
    }
  });

  /**
   * GET /v1/shares/:token
   * Public access: validate token + expiry. Returns assessment info.
   * No workspace header required (public endpoint).
   */
  app.get('/v1/shares/:token', async (request: FastifyRequest, reply: FastifyReply) => {
    const { token } = request.params as { token: string };

    try {
      const link = await service.validateToken(token, getRequestId(request));
      return reply.status(200).send({
        data: {
          assessmentId: link.assessmentId,
          expiresAt: link.expiresAt,
        },
      });
    } catch (err) {
      handleError(err, request, reply);
    }
  });

  /**
   * DELETE /v1/shares/:token/revoke
   * Revoke share link. Only the owning workspace can revoke.
   * Requires x-workspace-id header.
   */
  app.delete(
    '/v1/shares/:token/revoke',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const workspaceId = getWorkspaceId(request, reply);
      if (!workspaceId) return;

      const { token } = request.params as { token: string };

      try {
        const revoked = await service.revokeShareLink(token, workspaceId, getRequestId(request));
        return reply.status(200).send({
          data: {
            id: revoked.id,
            token: revoked.token,
            revokedAt: revoked.revokedAt,
          },
        });
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );
}
