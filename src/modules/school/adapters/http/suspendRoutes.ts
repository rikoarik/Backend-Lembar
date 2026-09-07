/**
 * School member suspend / unsuspend routes.
 *
 * POST /v1/school/members/:id/suspend   — suspend a member (school_admin only)
 * POST /v1/school/members/:id/unsuspend — reactivate a member (school_admin only)
 *
 * Auth: JWT Bearer via createJwtAuthMiddleware + requireRole(['school_admin'])
 * workspaceId: from request.jwtUser.workspaceId
 *
 * Mechanism: updates jwt_users, the same source of truth used by JWT auth.
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

export interface RegisterSuspendRoutesOptions {
  db: Database;
  jwtSecret: string;
}

export async function registerSuspendRoutes(
  app: FastifyInstance,
  options: RegisterSuspendRoutesOptions,
): Promise<void> {
  const { db, jwtSecret } = options;
  const auth = createJwtAuthMiddleware({ secret: jwtSecret, db });
  const adminOnly = requireRole(['school_admin']);

  // ── POST /v1/school/members/:id/suspend ─────────────────────────────────────
  app.post(
    '/v1/school/members/:id/suspend',
    { preHandler: [auth, adminOnly] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = getRequestId(request);
      const user = request.jwtUser!;

      if (!user.workspaceId) {
        throwApiError('forbidden', 'Akun tidak terhubung ke workspace sekolah');
      }
      const workspaceId = user.workspaceId!;
      const actorId = user.userId ?? 'unknown';
      const { id: memberId } = request.params as { id: string };

      const pool = getPool(db);
      if (!pool) {
        return reply.status(503).send({
          error: { code: 'DB_UNAVAILABLE', message: 'Database tidak tersedia', requestId, retryable: true },
        });
      }

      // Prevent self-suspension
      if (memberId === actorId) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_FAILED', message: 'Tidak dapat menangguhkan akun Anda sendiri', requestId, retryable: false },
        });
      }

      const targetAdmin = await pool.query<{ is_admin: boolean }>(
        `SELECT roles @> ARRAY['school_admin']::text[] AS is_admin
         FROM jwt_users WHERE id = $1::uuid AND workspace_id = $2::uuid`,
        [memberId, workspaceId],
      );
      if (targetAdmin.rows[0]?.is_admin) {
        const adminCount = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM jwt_users
           WHERE workspace_id = $1::uuid
             AND roles @> ARRAY['school_admin']::text[]
             AND suspended_at IS NULL`,
          [workspaceId],
        );
        if (Number(adminCount.rows[0]?.count ?? 0) <= 1) {
          return reply.status(409).send({
            error: { code: 'STATE_CONFLICT', message: 'Admin sekolah terakhir tidak dapat ditangguhkan', requestId, retryable: false },
          });
        }
      }

      // jwt_users is the source of truth for JWT roles and workspace membership.
      const res = await pool.query<{ id: string; state: string }>(
        `UPDATE jwt_users
            SET suspended_at = COALESCE(suspended_at, now()), updated_at = now()
          WHERE id = $1::uuid AND workspace_id = $2::uuid
          RETURNING id, CASE WHEN suspended_at IS NULL THEN 'active' ELSE 'suspended' END AS state`,
        [memberId, workspaceId],
      );

      if (res.rows.length === 0) {
        // Either member not found or already suspended/revoked
        const check = await pool.query<{ state: string }>(
          `SELECT CASE WHEN suspended_at IS NULL THEN 'active' ELSE 'suspended' END AS state
             FROM jwt_users WHERE id = $1::uuid AND workspace_id = $2::uuid`,
          [memberId, workspaceId],
        );
        if (check.rows.length === 0) {
          return reply.status(404).send({
            error: { code: 'NOT_FOUND', message: `Member ${memberId} tidak ditemukan di workspace ini`, requestId, retryable: false },
          });
        }
        // Already suspended — idempotent OK
        return reply.status(200).send({
          data: { id: memberId, state: check.rows[0]!.state },
        });
      }

      return reply.status(200).send({
        data: { id: memberId, state: 'suspended' },
      });
    },
  );

  // ── POST /v1/school/members/:id/unsuspend ────────────────────────────────────
  app.post(
    '/v1/school/members/:id/unsuspend',
    { preHandler: [auth, adminOnly] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = getRequestId(request);
      const user = request.jwtUser!;

      if (!user.workspaceId) {
        throwApiError('forbidden', 'Akun tidak terhubung ke workspace sekolah');
      }
      const workspaceId = user.workspaceId!;
      const { id: memberId } = request.params as { id: string };

      const pool = getPool(db);
      if (!pool) {
        return reply.status(503).send({
          error: { code: 'DB_UNAVAILABLE', message: 'Database tidak tersedia', requestId, retryable: true },
        });
      }

      // Reactivate the JWT user in this workspace.
      const res = await pool.query<{ id: string; state: string }>(
        `UPDATE jwt_users
            SET suspended_at = NULL, suspended_reason = NULL, updated_at = now()
          WHERE id = $1::uuid AND workspace_id = $2::uuid AND suspended_at IS NOT NULL
          RETURNING id, 'active'::text AS state`,
        [memberId, workspaceId],
      );

      if (res.rows.length === 0) {
        const check = await pool.query<{ state: string }>(
          `SELECT CASE WHEN suspended_at IS NULL THEN 'active' ELSE 'suspended' END AS state
             FROM jwt_users WHERE id = $1::uuid AND workspace_id = $2::uuid`,
          [memberId, workspaceId],
        );
        if (check.rows.length === 0) {
          return reply.status(404).send({
            error: { code: 'NOT_FOUND', message: `Member ${memberId} tidak ditemukan di workspace ini`, requestId, retryable: false },
          });
        }
        // Already active — idempotent OK
        return reply.status(200).send({
          data: { id: memberId, state: check.rows[0]!.state },
        });
      }

      return reply.status(200).send({
        data: { id: memberId, state: 'active' },
      });
    },
  );
}
