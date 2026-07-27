/**
 * School usage HTTP routes.
 *
 * GET /v1/school/usage — workspace quota usage with per-user breakdown and monthly trend.
 *
 * Auth: JWT Bearer via request.jwtUser (any authenticated school member).
 * DB:   raw SQL via getPool(db).
 *
 * Data sources:
 *   - workspace_plans     → quota limit + total used
 *   - quota_reservations  → per-user used counts (when available)
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
  const auth = createJwtAuthMiddleware({ secret: jwtSecret, db });
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

      // ── 1. Aggregate quota used from quota_reservations ────────────────────
      const quotaUsedRes = await pool.query<{ quota_used: string }>(
        `SELECT COALESCE(SUM(units), 0) AS quota_used
         FROM quota_reservations
         WHERE workspace_id = $1`,
        [workspaceId],
      );

      const quotaUsed = parseInt(quotaUsedRes.rows[0]?.quota_used ?? '0', 10);

      // ── 2. Get quota limit from workspace_plans ────────────────────────────
      // quota_limit is determined by plan: free → 10, pro → unlimited (0 = no limit)
      const planRes = await pool.query<{ plan: string }>(
        `SELECT COALESCE(plan, 'free') AS plan
         FROM workspace_plans
         WHERE workspace_id = $1 AND active = true
         LIMIT 1`,
        [workspaceId],
      );

      const plan = planRes.rows[0]?.plan ?? 'free';
      const quotaLimit = plan === 'pro' ? 0 : 10;

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

      // ── 4. Per-user breakdown from jwt_users ──────────────────────────────
      // For now, return workspace-level usage since quota_reservations
      // does not have a user_id column for per-user breakdown.
      const breakdownRes = await pool.query<{
        user_id: string;
        name: string;
        email: string;
      }>(
        `SELECT
           u.id AS user_id,
           COALESCE(u.name, 'Unknown')  AS name,
           COALESCE(u.email, '')        AS email
         FROM jwt_users u
         WHERE u.workspace_id = $1::uuid
         ORDER BY u.created_at ASC`,
        [workspaceId],
      );

      const breakdown = breakdownRes.rows.map((r) => ({
        userId: r.user_id,
        name: r.name,
        email: r.email,
        used: 0, // Per-user breakdown not available without user_id on reservations
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
