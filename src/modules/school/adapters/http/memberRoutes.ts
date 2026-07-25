/**
 * B7-05 — School member management routes.
 *
 * GET    /v1/school/members          — list workspace members (JWT, school_admin)
 *                                      ?q=     search by email/name (case-insensitive)
 *                                      ?role=  filter by role (teacher | school_admin)
 *                                      ?page=  1-based page number (default 1)
 *                                      ?limit= page size 1–100 (default 20)
 * GET    /v1/school/members/:id      — member detail: id, email, name, role, status,
 *                                      joinedAt, lastActiveAt, stats (JWT, school_admin)
 * POST   /v1/school/members/invite   — invite member via email (school_admin only)
 * PATCH  /v1/school/members/:id/role — update member role (school_admin only)
 * DELETE /v1/school/members/:id      — remove member from workspace (school_admin only)
 *
 * Auth (GET endpoints): JWT Bearer — workspaceId read from request.jwtUser.workspaceId
 * Auth (mutating endpoints): x-tenant-id header + x-user-role header (legacy, kept for BC)
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import type { SchoolService } from '../../application/SchoolService.js';
import type { SchoolMember } from '../../domain/types.js';
import { createJwtAuthMiddleware } from '../../../../common/middleware/jwtMultiRoleAuth.js';
import { throwApiError } from '../../../../common/errors/apiError.js';
import { getPool, type Database } from '../../../../infrastructure/database/db.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'req_unknown';
}

/** Legacy header-based guard — kept for mutating endpoints (invite, patch, delete). */
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
  db: Database;
  jwtSecret: string;
}

export async function registerMemberRoutes(
  app: FastifyInstance,
  options: RegisterMemberRoutesOptions,
): Promise<void> {
  const { service, db, jwtSecret } = options;
  const auth = createJwtAuthMiddleware({ secret: jwtSecret });

  // ── GET /v1/school/members ─────────────────────────────────────────────────
  /**
   * List workspace members with server-side search, role filter, and pagination.
   *
   * Auth:   JWT Bearer — workspaceId from jwtUser.workspaceId
   * Query:  ?q=<string>         search email (case-insensitive substring)
   *         ?role=<role>        filter by role (teacher | school_admin)
   *         ?page=<number>      1-based page (default 1)
   *         ?limit=<number>     items per page, 1–100 (default 20)
   * Returns: { data: SchoolMember[], meta: { total, page, limit, pages } }
   */
  app.get(
    '/v1/school/members',
    { preHandler: [auth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = getRequestId(request);
      const user = request.jwtUser!;

      if (!user.workspaceId) {
        throwApiError('forbidden', 'Akun tidak terhubung ke workspace sekolah');
      }
      const workspaceId = user.workspaceId!;
      const tenantId = user.userId; // tenantId === userId for single-tenant JWT users

      const { q, role, page: pageStr, limit: limitStr } = request.query as {
        q?: string;
        role?: string;
        page?: string;
        limit?: string;
      };

      const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(limitStr ?? '20', 10) || 20));

      // Fetch all members for the workspace from the in-memory store
      const allMembers = await service.listMembers(tenantId, workspaceId);

      // Server-side filtering
      let filtered = allMembers;

      if (q && q.trim()) {
        const needle = q.trim().toLowerCase();
        filtered = filtered.filter((m) => m.email.toLowerCase().includes(needle));
      }

      if (role && role.trim()) {
        filtered = filtered.filter((m) => m.role === role);
      }

      const total = filtered.length;
      const pages = Math.ceil(total / limit) || 1;
      const offset = (page - 1) * limit;
      const data = filtered.slice(offset, offset + limit);

      return reply.status(200).send({
        data,
        meta: { total, page, limit, pages },
      });
    },
  );

  // ── GET /v1/school/members/:id ─────────────────────────────────────────────
  /**
   * Member detail: id, email, name, role, status, joinedAt, lastActiveAt, stats.
   *
   * Auth:    JWT Bearer — workspaceId from jwtUser.workspaceId
   * Params:  :id — member's user id
   * Returns: { data: MemberDetail }
   *
   * stats.assessmentCount — assessments created by this user in the workspace
   * stats.quotaUsed        — total quota consumed by this user in the workspace
   * name / lastActiveAt    — looked up from jwt_users table (null if not found)
   */
  app.get(
    '/v1/school/members/:id',
    { preHandler: [auth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = getRequestId(request);
      const user = request.jwtUser!;

      if (!user.workspaceId) {
        throwApiError('forbidden', 'Akun tidak terhubung ke workspace sekolah');
      }
      const workspaceId = user.workspaceId!;
      const tenantId = user.userId;

      const { id: memberId } = request.params as { id: string };

      // 1. Find member in the workspace store
      const allMembers = await service.listMembers(tenantId, workspaceId);
      const member = allMembers.find((m) => m.id === memberId);

      if (!member) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Member ${memberId} not found in workspace`,
            requestId,
            retryable: false,
          },
        });
      }

      // 2. Enrich from DB (name, lastActiveAt, stats) — graceful fallback when DB unavailable
      let name: string | null = null;
      let lastActiveAt: string | null = null;
      let assessmentCount = 0;
      let quotaUsed = 0;

      const pool = getPool(db);
      if (pool) {
        try {
          // name + lastActiveAt from jwt_users
          const userRow = await pool.query<{
            name: string | null;
            last_active_at: string | null;
          }>(
            `SELECT name, last_active_at FROM jwt_users WHERE id = $1 LIMIT 1`,
            [memberId],
          );
          if (userRow.rows.length > 0) {
            name = userRow.rows[0]!.name ?? null;
            lastActiveAt = userRow.rows[0]!.last_active_at ?? null;
          }

          // assessmentCount — assessments authored by this member in the workspace
          const assessmentRow = await pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
               FROM assessments
              WHERE workspace_id = $1
                AND created_by = $2`,
            [workspaceId, memberId],
          );
          assessmentCount = parseInt(assessmentRow.rows[0]?.count ?? '0', 10);

          // quotaUsed — total quota consumed by this member in the workspace
          const quotaRow = await pool.query<{ total: string }>(
            `SELECT COALESCE(SUM(tokens_used), 0)::text AS total
               FROM quota_reservations
              WHERE workspace_id = $1
                AND user_id = $2`,
            [workspaceId, memberId],
          );
          quotaUsed = parseInt(quotaRow.rows[0]?.total ?? '0', 10);
        } catch {
          // Non-fatal: return member data without enrichment if DB query fails
        }
      }

      return reply.status(200).send({
        data: {
          id: member.id,
          email: member.email,
          name,
          role: member.role,
          status: member.state,
          joinedAt: member.joinedAt,
          lastActiveAt,
          stats: {
            assessmentCount,
            quotaUsed,
          },
        },
      });
    },
  );

  // ── POST /v1/school/members/invite ─────────────────────────────────────────
  /**
   * Invite a new member via email.
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
      createdByUserId,
      tenantId,
    });

    return reply.status(201).send({ data: result });
  });

  // ── PATCH /v1/school/members/:id/role ──────────────────────────────────────
  /**
   * Update a member's role.
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

      const updated = await service.updateMemberRole(tenantId, workspaceId, memberId, role as SchoolMember['role']);

      if (!updated) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: `Member ${memberId} not found in workspace`, requestId, retryable: false },
        });
      }

      return reply.status(200).send({ data: updated });
    },
  );

  // ── DELETE /v1/school/members/:id ──────────────────────────────────────────
  /**
   * Remove a member from the workspace.
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
