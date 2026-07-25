/**
 * School usage HTTP routes.
 *
 * GET /v1/school/usage — workspace quota usage with per-user breakdown and monthly trend.
 *
 * Auth: JWT Bearer via request.jwtUser (any authenticated school member).
 * DB:   raw SQL via getPool(db).
 *
 * Data sources:
 *   - quota_reservations  → quotaUsed / quotaLimit + per-user used counts
 *   - jwt_users           → name + email for breakdown
 *   - ai_jobs_audit       → monthly trend (succeeded jobs per month)
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { getPool, type Database } from '../../../../infrastructure/database/db.js';
import {
  createJwtAuthMiddleware,
  requireRole,
} from '../../../../common/middleware/jwtMultiRoleAuth.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? (req as any).requestId ?? 'req_unknown';
}

export interface RegisterUsageRoutesOptions {
  db: Database;
  jwtSecret: string;
}

export async function registerUsageRoutes(
  app: FastifyInstance,
  options: RegisterUsageRoutesOptions,
): Promise<void> {
  const { db, jwtSecret } = options;
  const auth = createJwtAuthMiddleware({ secret: jwtSecret });
  const anyMember = requireRole(['school_admin', 'teacher', 'subscriber']);

  // ── GET /v1/school/usage ───────────────────────────────────────────────────
  app.get(
    '/v1/school/usage',
    { preHandler: [auth, anyMember] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = getRequestId(request);
      const workspaceId = request.jwtUser?.workspaceId;

      if (!workspaceId) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Token tidak memiliki workspaceId',
            requestId,
            retryable: false,
          },
        });
      }

      const pool = getPool(db);
      if (!pool) {
        return reply.status(503).send({
          error: { code: 'DB_UNAVAILABLE', message: 'Database tidak tersedia', requestId, retryable: true },
        });
      }

      // ── 1. Aggregate quota used + limit from quota_reservations ────────────
      const quotaRes = await pool.query<{
        quota_used: string;
        quota_limit: string;
      }>(
        `SELECT
           COALESCE(SUM(tokens_reserved), 0)      AS quota_used,
           COALESCE(MAX(quota_limit), 0)           AS quota_limit
         FROM quota_reservations
         WHERE workspace_id = $1`,
        [workspaceId],
      );

      const quotaUsed = parseInt(quotaRes.rows[0]?.quota_used ?? '0', 10);
      const quotaLimit = parseInt(quotaRes.rows[0]?.quota_limit ?? '0', 10);

      // ── 2. Per-user breakdown: reservations joined with jwt_users ──────────
      const breakdownRes = await pool.query<{
        user_id: string;
        name: string;
        email: string;
        used: string;
      }>(
        `SELECT
           qr.user_id,
           COALESCE(u.name, 'Unknown')             AS name,
           COALESCE(u.email, '')                   AS email,
           SUM(qr.tokens_reserved)                 AS used
         FROM quota_reservations qr
         LEFT JOIN jwt_users u ON u.id::text = qr.user_id::text
         WHERE qr.workspace_id = $1
         GROUP BY qr.user_id, u.name, u.email
         ORDER BY used DESC`,
        [workspaceId],
      );

      const breakdown = breakdownRes.rows.map((r) => ({
        userId: r.user_id,
        name: r.name,
        email: r.email,
        used: parseInt(r.used, 10),
      }));

      // ── 3. Monthly trend from ai_jobs_audit (last 12 months) ──────────────
      const trendRes = await pool.query<{
        month: string;
        used: string;
      }>(
        `SELECT
           TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
           COUNT(*)                                             AS used
         FROM ai_jobs_audit
         WHERE workspace_id = $1
           AND outcome = 'succeeded'
           AND created_at >= NOW() - INTERVAL '12 months'
         GROUP BY DATE_TRUNC('month', created_at)
         ORDER BY DATE_TRUNC('month', created_at) ASC`,
        [workspaceId],
      );

      const trend = trendRes.rows.map((r) => ({
        month: r.month,
        used: parseInt(r.used, 10),
      }));

      return reply.status(200).send({
        data: {
          quotaUsed,
          quotaLimit,
          breakdown,
          trend,
        },
      });
    },
  );
}
