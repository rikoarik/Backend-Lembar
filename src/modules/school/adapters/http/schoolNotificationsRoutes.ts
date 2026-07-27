/**
 * School notifications route.
 *
 * GET /v1/school/notifications — recent notifications from notification_outbox
 *                                for the current workspace (school_admin only).
 *
 * Auth: JWT Bearer via createJwtAuthMiddleware + requireRole(['school_admin'])
 * workspaceId: from request.jwtUser.workspaceId
 *
 * Query params:
 *   ?page=   1-based page (default 1)
 *   ?limit=  page size 1–100 (default 20)
 *   ?status= filter by status ('pending' | 'delivered' | 'failed') — optional
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { getPool, type Database } from '../../../../infrastructure/database/db.js';
import {
  createJwtAuthMiddleware,
  requireRole,
} from '../../../../common/middleware/jwtMultiRoleAuth.js';
import { throwApiError } from '../../../../common/errors/apiError.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'req_unknown';
}

export interface RegisterSchoolNotificationsRoutesOptions {
  db: Database;
  jwtSecret: string;
}

export async function registerSchoolNotificationsRoutes(
  app: FastifyInstance,
  options: RegisterSchoolNotificationsRoutesOptions,
): Promise<void> {
  const { db, jwtSecret } = options;
  const auth = createJwtAuthMiddleware({ secret: jwtSecret, db });
  const adminOnly = requireRole(['school_admin']);

  // ── GET /v1/school/notifications ────────────────────────────────────────────
  app.get(
    '/v1/school/notifications',
    { preHandler: [auth, adminOnly] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = getRequestId(request);
      const user = request.jwtUser!;

      if (!user.workspaceId) {
        throwApiError('forbidden', 'Akun tidak terhubung ke workspace sekolah');
      }
      const workspaceId = user.workspaceId!;

      const { page: pageStr, limit: limitStr, status } = request.query as {
        page?: string;
        limit?: string;
        status?: string;
      };

      const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(limitStr ?? '20', 10) || 20));
      const offset = (page - 1) * limit;

      const pool = getPool(db);
      if (!pool) {
        // Graceful degradation: return empty list if DB unavailable
        return reply.status(200).send({
          data: [],
          meta: { total: 0, page, limit, pages: 0 },
        });
      }

      // Check if notification_outbox table exists — it may not be in all deployments
      const tableCheck = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name   = 'notification_outbox'
         ) AS exists`,
      );

      if (!tableCheck.rows[0]?.exists) {
        return reply.status(200).send({
          data: [],
          meta: { total: 0, page, limit, pages: 0 },
        });
      }

      // Check if workspace_id column exists in notification_outbox
      const colCheck = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name   = 'notification_outbox'
             AND column_name  = 'workspace_id'
         ) AS exists`,
      );

      const hasWorkspaceCol = colCheck.rows[0]?.exists ?? false;

      // Build WHERE clause depending on schema
      const params: unknown[] = [];
      const conditions: string[] = [];

      if (hasWorkspaceCol) {
        params.push(workspaceId);
        conditions.push(`workspace_id = $${params.length}`);
      }

      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Total count
      const countRes = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM notification_outbox ${whereClause}`,
        params,
      );
      const total = parseInt(countRes.rows[0]?.count ?? '0', 10);
      const pages = Math.ceil(total / limit);

      // Rows — select safe columns only (payload may contain sensitive data)
      const rowParams = [...params, limit, offset];
      const rowRes = await pool.query<{
        id: string;
        type: string | null;
        status: string;
        attempt_count: number;
        last_error: string | null;
        visible_at: Date | null;
        created_at: Date | null;
      }>(
        `SELECT
           id,
           template_key AS type,
           status,
           attempt_count,
           last_error,
           visible_at,
           created_at
         FROM notification_outbox
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}`,
        rowParams,
      );

      return reply.status(200).send({
        data: rowRes.rows.map((r) => ({
          id: r.id,
          type: r.type ?? 'unknown',
          status: r.status,
          attemptCount: r.attempt_count,
          lastError: r.last_error ?? null,
          visibleAt: r.visible_at ?? null,
          createdAt: r.created_at ?? null,
        })),
        meta: { total, page, limit, pages },
      });
    },
  );
}
