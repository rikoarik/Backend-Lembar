/**
 * B7-01 — School HTTP routes.
 *
 * POST /v1/invitations — create one-time invitation token
 * POST /v1/invitations/accept — accept invitation (create account + join workspace)
 * GET /v1/school/:workspaceId/members — list workspace members
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import type { SchoolService } from '../../application/SchoolService.js';
import {
  ExpiredInvitationError,
  InvalidInvitationError,
  WeakPasswordError,
} from '../../application/SchoolService.js';
import { createJwtAuthMiddleware, requireRole } from '../../../../common/middleware/jwtMultiRoleAuth.js';
import type { Database } from '../../../../infrastructure/database/db.js';
import { throwApiError } from '../../../../common/errors/apiError.js';

function getRequestId(req: FastifyRequest): string {
  // Prefer the caller's correlation id, then Fastify's own generated id — never
  // the placeholder, or support has nothing to trace with (see FE audit BUG-26).
  return (req.headers['x-request-id'] as string | undefined) ?? req.id ?? 'req_unknown';
}

export interface RegisterSchoolRoutesOptions {
  service: SchoolService;
  jwtSecret: string;
  db?: Database;
}

export async function registerSchoolRoutes(
  app: FastifyInstance,
  options: RegisterSchoolRoutesOptions,
): Promise<void> {
  const { service, jwtSecret, db } = options;
  const auth = createJwtAuthMiddleware({ secret: jwtSecret, db });
  const adminOnly = requireRole(['school_admin']);

  /**
   * POST /v1/invitations
   * Body: { workspaceId, email, role, tenantId, createdByUserId }
   * Returns one-time token (high-entropy, 64 hex chars = 32 bytes).
   */
  app.post('/v1/invitations', { preHandler: [auth, adminOnly] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown> | null | undefined;

    const workspaceId = request.jwtUser?.workspaceId;
    const email = body?.['email'] as string | undefined;
    const role = body?.['role'] as string | undefined;
    const tenantId = workspaceId;
    const createdByUserId = request.jwtUser?.userId;

    if (!workspaceId || !email || !role || !tenantId || !createdByUserId) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Token workspaceId, email, dan role wajib ada',
          requestId: getRequestId(request),
          retryable: false,
        },
      });
    }

    const result = await service.createInvitation({
      workspaceId,
      email,
      role: role as 'teacher' | 'school_admin',
      tenantId,
      createdByUserId,
    });

    return reply.status(201).send({ data: result });
  });

  /**
   * POST /v1/invitations/accept
   * Body: { token, password }
   * Accepts invitation, creates user if needed, adds to workspace.
   * Returns { userId, workspaceId }.
   *
   * Error contract (BUG-20b):
   * - 400 VALIDATION_FAILED — password fails the register policy (same rule).
   * - 404 RESOURCE_NOT_FOUND — token unknown, already used, or revoked.
   * - 410 INVITATION_EXPIRED  — token exists but past `expires_at`.
   */
  app.post('/v1/invitations/accept', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown> | null | undefined;

    const token = body?.['token'] as string | undefined;
    const password = body?.['password'] as string | undefined;

    if (!token || !password) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Missing required fields: token, password',
          requestId: getRequestId(request),
          retryable: false,
        },
      });
    }

    try {
      const result = await service.acceptInvitation({ token, password });
      return reply.status(200).send({ data: result });
    } catch (err) {
      if (err instanceof WeakPasswordError) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: err.message,
            requestId: getRequestId(request),
            retryable: false,
          },
        });
      }
      if (err instanceof ExpiredInvitationError) {
        // Distinguishable from "unknown token" so the client can offer to resend
        // instead of showing a dead-end "not found".
        return reply.status(410).send({
          error: {
            code: 'INVITATION_EXPIRED',
            message: err.message,
            requestId: getRequestId(request),
            retryable: false,
          },
        });
      }
      if (err instanceof InvalidInvitationError) {
        return reply.status(404).send({
          error: {
            code: 'RESOURCE_NOT_FOUND',
            message: err.message,
            requestId: getRequestId(request),
            retryable: false,
          },
        });
      }
      throw err;
    }
  });

  /**
   * GET /v1/invitations/preview?token=...
   * Public, read-only view of an invitation so the activation page can render
   * "active / expired / used" before the invitee types a password.
   * Never returns the token or the token hash.
   */
  app.get('/v1/invitations/preview', async (request: FastifyRequest, reply: FastifyReply) => {
    const { token } = request.query as { token?: string };
    if (!token) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Missing required query parameter: token',
          requestId: getRequestId(request),
          retryable: false,
        },
      });
    }

    const preview = await service.previewInvitation(token);
    return reply.status(200).send({ data: preview });
  });

  /**
   * GET /v1/school/:workspaceId/members
   * Lists members in a school workspace.
   */
  app.get(
    '/v1/school/:workspaceId/members',
    { preHandler: [auth, adminOnly] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const workspaceId = request.jwtUser?.workspaceId;
      if (!workspaceId) throwApiError('forbidden', 'Akun tidak terhubung ke workspace sekolah');
      const tenantId = workspaceId;

      const members = await service.listMembers(tenantId, workspaceId);
      return reply.status(200).send({ data: members });
    },
  );
}
