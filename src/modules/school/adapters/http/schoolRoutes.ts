/**
 * B7-01 — School HTTP routes.
 *
 * POST /v1/invitations — create one-time invitation token
 * POST /v1/invitations/accept — accept invitation (create account + join workspace)
 * GET /v1/school/:workspaceId/members — list workspace members
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import type { SchoolService } from '../../application/SchoolService.js';
import { InvalidInvitationError } from '../../application/SchoolService.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'req_unknown';
}

export interface RegisterSchoolRoutesOptions {
  service: SchoolService;
}

export async function registerSchoolRoutes(
  app: FastifyInstance,
  options: RegisterSchoolRoutesOptions,
): Promise<void> {
  const { service } = options;

  /**
   * POST /v1/invitations
   * Body: { workspaceId, email, role, tenantId, createdByUserId }
   * Returns one-time token (high-entropy, 64 hex chars = 32 bytes).
   */
  app.post('/v1/invitations', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown> | null | undefined;

    const workspaceId = body?.['workspaceId'] as string | undefined;
    const email = body?.['email'] as string | undefined;
    const role = body?.['role'] as string | undefined;
    const tenantId = body?.['tenantId'] as string | undefined;
    const createdByUserId = body?.['createdByUserId'] as string | undefined;

    if (!workspaceId || !email || !role || !tenantId || !createdByUserId) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Missing required fields: workspaceId, email, role, tenantId, createdByUserId',
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
   * GET /v1/school/:workspaceId/members
   * Lists members in a school workspace.
   */
  app.get(
    '/v1/school/:workspaceId/members',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const tenantId = (request.headers['x-tenant-id'] as string | undefined) ?? '';

      if (!tenantId) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Missing x-tenant-id header',
            requestId: getRequestId(request),
            retryable: false,
          },
        });
      }

      const members = await service.listMembers(tenantId, workspaceId);
      return reply.status(200).send({ data: members });
    },
  );
}
