/**
 * School Audit + Invitations routes — school_admin only.
 *
 * GET    /v1/school/audit              — workspace activity log
 * GET    /v1/school/invitations        — list pending invitations
 * DELETE /v1/school/invitations/:id   — cancel a pending invitation
 *
 * Auth: JWT Bearer, role must be school_admin
 * workspaceId is read from request.jwtUser.workspaceId
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getPool, type Database } from '../../../../infrastructure/database/db.js';
import {
  createJwtAuthMiddleware,
  requireRole,
} from '../../../../common/middleware/jwtMultiRoleAuth.js';
import { throwApiError } from '../../../../common/errors/apiError.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? req.requestId ?? 'req_unknown';
}

export interface RegisterSchoolAuditRoutesOptions {
  db: Database;
  jwtSecret: string;
}

export async function registerSchoolAuditRoutes(
  app: FastifyInstance,
  options: RegisterSchoolAuditRoutesOptions,
): Promise<void> {
  const { db, jwtSecret } = options;
  const auth = createJwtAuthMiddleware({ secret: jwtSecret, db });
  const adminOnly = requireRole(['school_admin', 'superadmin']);

  // ── GET /v1/school/audit ─────────────────────────────────────────────────
  app.get('/v1/school/audit', { preHandler: [auth, adminOnly] }, async (request, reply) => {
    const requestId = getRequestId(request);
    const user = request.jwtUser!;

    if (!user.workspaceId) {
      throwApiError('forbidden', 'Akun tidak terhubung ke workspace sekolah');
    }
    const workspaceId = user.workspaceId!;

    const {
      page: pageStr,
      limit: limitStr,
      actor,
      action,
      q,
    } = request.query as {
      page?: string;
      limit?: string;
      actor?: string;
      action?: string;
      q?: string;
    };

    const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(limitStr ?? '50', 10) || 50));
    const offset = (page - 1) * limit;

    const pool = getPool(db);
    if (!pool) {
      return reply.status(200).send({ data: [], meta: { total: 0, page, limit, pages: 0 } });
    }

    // Build dynamic WHERE clauses
    const conditions: string[] = ['e.tenant_id = $1::uuid'];
    const countParams: unknown[] = [workspaceId];
    const rowParams: unknown[] = [workspaceId];

    if (actor) {
      countParams.push(`%${actor}%`);
      rowParams.push(`%${actor}%`);
      const idx = countParams.length;
      conditions.push(`e.user_id::text ILIKE $${idx}`);
    }

    if (action) {
      countParams.push(action);
      rowParams.push(action);
      const idx = countParams.length;
      conditions.push(`e.action = $${idx}`);
    }

    if (q?.trim()) {
      countParams.push(`%${q.trim()}%`);
      rowParams.push(`%${q.trim()}%`);
      const idx = countParams.length;
      conditions.push(
        `(e.action ILIKE $${idx} OR e.user_id::text ILIKE $${idx} OR e.metadata::text ILIKE $${idx})`,
      );
    }

    const whereClause = conditions.join(' AND ');

    rowParams.push(limit, offset);
    const limitIdx = rowParams.length - 1;
    const offsetIdx = rowParams.length;

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM auth_audit_events e
      WHERE ${whereClause}
    `;

    const rowsSql = `
      SELECT
        e.id,
        e.occurred_at          AS "at",
        e.user_id             AS "actor",
        e.action,
        COALESCE(e.metadata, '') AS "target",
        e.metadata
      FROM auth_audit_events e
      WHERE ${whereClause}
      ORDER BY e.occurred_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const [countRes, rowsRes] = await Promise.all([
      pool.query<{ total: number }>(countSql, countParams),
      pool.query<{
        id: string;
        at: string;
        actor: string | null;
        action: string;
        target: string | null;
        metadata: unknown;
      }>(rowsSql, rowParams),
    ]);

    const total = countRes.rows[0]?.total ?? 0;
    const pages = Math.ceil(total / limit);

    return reply.status(200).send({
      data: rowsRes.rows,
      meta: { total, page, limit, pages },
    });
  });

  // ── GET /v1/school/invitations ───────────────────────────────────────────
  app.get('/v1/school/invitations', { preHandler: [auth, adminOnly] }, async (request, reply) => {
    const requestId = getRequestId(request);
    const user = request.jwtUser!;

    if (!user.workspaceId) {
      throwApiError('forbidden', 'Akun tidak terhubung ke workspace sekolah');
    }
    const workspaceId = user.workspaceId!;

    const pool = getPool(db);
    if (!pool) {
      return reply.status(200).send({ data: [] });
    }

    const res = await pool.query<{
      id: string;
      email: string;
      role: string | null;
      invitedBy: string | null;
      createdAt: string;
      expiresAt: string | null;
    }>(
      `SELECT
         i.id,
         i.email,
         i.role,
         NULL::text     AS "invitedBy",
         i.created_at   AS "createdAt",
         i.expires_at   AS "expiresAt"
       FROM auth_school_invitations i
       WHERE i.tenant_id = $1::uuid
         AND i.state = 'pending'
       ORDER BY i.created_at DESC`,
      [workspaceId],
    );

    return reply.status(200).send({ data: res.rows });
  });

  // ── DELETE /v1/school/invitations/:id ────────────────────────────────────
  app.delete(
    '/v1/school/invitations/:id',
    { preHandler: [auth, adminOnly] },
    async (request, reply) => {
      const requestId = getRequestId(request);
      const user = request.jwtUser!;

      if (!user.workspaceId) {
        throwApiError('forbidden', 'Akun tidak terhubung ke workspace sekolah');
      }
      const workspaceId = user.workspaceId!;
      const { id } = request.params as { id: string };

      const pool = getPool(db);
      if (!pool) {
        return reply.status(503).send({
          error: {
            code: 'DB_UNAVAILABLE',
            message: 'Database tidak tersedia',
            requestId,
            retryable: true,
          },
        });
      }

      // Only cancel if still pending and belongs to this workspace
      const res = await pool.query<{ id: string }>(
        `UPDATE auth_school_invitations
         SET state = 'revoked'
         WHERE id = $1
           AND tenant_id = $2::uuid
           AND state = 'pending'
         RETURNING id`,
        [id, workspaceId],
      );

      if (res.rows.length === 0) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Undangan tidak ditemukan atau sudah tidak aktif',
            requestId,
            retryable: false,
          },
        });
      }

      return reply.status(200).send({ data: { id, cancelled: true } });
    },
  );
}
