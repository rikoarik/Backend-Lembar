/**
 * B7-05 — School member management routes.
 *
 * GET    /v1/school/members          — list workspace members (school_admin only)
 * POST   /v1/school/members/invite   — invite member via email (school_admin only)
 * PATCH  /v1/school/members/:id/role — update member role (school_admin only)
 * DELETE /v1/school/members/:id      — remove member from workspace (school_admin only)
 *
 * All routes require:
 *   Headers: x-tenant-id (tenant isolation), x-user-role (must be school_admin)
 *   Query:   workspaceId (required)
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import type { SchoolService } from '../../application/SchoolService.js';
import type { SchoolMember } from '../../domain/types.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'req_unknown';
}

function requireSchoolAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): { tenantId: string; workspaceId: string; requestId: string } | null {
  const requestId = getRequestId(request);
  const tenantId = (request.headers['x-tenant-id'] as string | undefined) ?? '';
  const userRole = (request.headers['x-user-role'] as string | undefined) ?? '';
  const { workspaceId } = request.query as { workspaceId?: string };

  if (!tenantId) {
    void reply.status(400).send({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Missing x-tenant-id header',
        requestId,
        retryable: false,
      },
    });
    return null;
  }

  if (userRole !== 'school_admin') {
    void reply.status(403).send({
      error: {
        code: 'PERMISSION_DENIED',
        message: 'This endpoint requires school_admin role',
        requestId,
        retryable: false,
      },
    });
    return null;
  }

  if (!workspaceId) {
    void reply.status(400).send({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Missing workspaceId query parameter',
        requestId,
        retryable: false,
      },
    });
    return null;
  }

  return { tenantId, workspaceId, requestId };
}

export interface RegisterMemberRoutesOptions {
  service: SchoolService;
}

export async function registerMemberRoutes(
  app: FastifyInstance,
  options: RegisterMemberRoutesOptions,
): Promise<void> {
  const { service } = options;

  /**
   * GET /v1/school/members
   * Headers: x-tenant-id, x-user-role
   * Query:   workspaceId
   * Returns: { data: SchoolMember[] }
   */
  app.get('/v1/school/members', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireSchoolAdmin(request, reply);
    if (!ctx) return;
    const { tenantId, workspaceId } = ctx;

    const members = await service.listMembers(tenantId, workspaceId);
    return reply.status(200).send({ data: members });
  });

  /**
   * POST /v1/school/members/invite
   * Headers: x-tenant-id, x-user-role, x-user-id (invoker's userId)
   * Query:   workspaceId
   * Body:    { email, role }
   * Returns: { data: SchoolInvitationResult }
   */
  app.post('/v1/school/members/invite', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = getRequestId(request);
    const tenantId = (request.headers['x-tenant-id'] as string | undefined) ?? '';
    const userRole = (request.headers['x-user-role'] as string | undefined) ?? '';
    const createdByUserId = (request.headers['x-user-id'] as string | undefined) ?? '';
    const { workspaceId } = request.query as { workspaceId?: string };
    const body = request.body as Record<string, unknown> | null | undefined;

    if (!tenantId) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'Missing x-tenant-id header', requestId, retryable: false },
      });
    }

    if (userRole !== 'school_admin') {
      return reply.status(403).send({
        error: { code: 'PERMISSION_DENIED', message: 'This endpoint requires school_admin role', requestId, retryable: false },
      });
    }

    if (!workspaceId) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'Missing workspaceId query parameter', requestId, retryable: false },
      });
    }

    const email = body?.['email'] as string | undefined;
    const role = body?.['role'] as string | undefined;

    if (!email || !role) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'Missing required fields: email, role', requestId, retryable: false },
      });
    }

    const allowedRoles: SchoolMember['role'][] = ['teacher', 'school_admin'];
    if (!allowedRoles.includes(role as SchoolMember['role'])) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: `Invalid role. Allowed values: ${allowedRoles.join(', ')}`,
          requestId,
          retryable: false,
        },
      });
    }

    const result = await service.createInvitation({
      workspaceId,
      email,
      role: role as SchoolMember['role'],
      tenantId,
      createdByUserId: createdByUserId || 'system',
    });

    return reply.status(201).send({ data: result });
  });

  /**
   * PATCH /v1/school/members/:id/role
   * Headers: x-tenant-id, x-user-role
   * Query:   workspaceId
   * Body:    { role }
   * Returns: { data: SchoolMember }
   */
  app.patch(
    '/v1/school/members/:id/role',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireSchoolAdmin(request, reply);
      if (!ctx) return;
      const { tenantId, workspaceId, requestId } = ctx;

      const { id: memberId } = request.params as { id: string };
      const body = request.body as Record<string, unknown> | null | undefined;
      const role = body?.['role'] as string | undefined;

      if (!role) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_FAILED', message: 'Missing required field: role', requestId, retryable: false },
        });
      }

      const allowedRoles: SchoolMember['role'][] = ['teacher', 'school_admin'];
      if (!allowedRoles.includes(role as SchoolMember['role'])) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: `Invalid role. Allowed values: ${allowedRoles.join(', ')}`,
            requestId,
            retryable: false,
          },
        });
      }

      const updated = await service.updateMemberRole(
        tenantId,
        workspaceId,
        memberId,
        role as SchoolMember['role'],
      );

      if (!updated) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: `Member ${memberId} not found in workspace`, requestId, retryable: false },
        });
      }

      return reply.status(200).send({ data: updated });
    },
  );

  /**
   * DELETE /v1/school/members/:id
   * Headers: x-tenant-id, x-user-role
   * Query:   workspaceId
   * Returns: 204 No Content
   */
  app.delete(
    '/v1/school/members/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireSchoolAdmin(request, reply);
      if (!ctx) return;
      const { tenantId, workspaceId, requestId } = ctx;

      const { id: memberId } = request.params as { id: string };

      const removed = await service.removeMember(tenantId, workspaceId, memberId);

      if (!removed) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: `Member ${memberId} not found in workspace`, requestId, retryable: false },
        });
      }

      return reply.status(204).send();
    },
  );
}
