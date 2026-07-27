/**
 * School settings HTTP routes.
 *
 * GET  /v1/school/settings — school profile (school_admin | teacher)
 * PATCH /v1/school/settings — update school name (school_admin only, audit-logged)
 *
 * Auth: JWT Bearer via request.jwtUser (populated by createJwtAuthMiddleware).
 * DB:   raw SQL via getPool(db).
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

export interface RegisterSettingsRoutesOptions {
  db: Database;
  jwtSecret: string;
}

export async function registerSettingsRoutes(
  app: FastifyInstance,
  options: RegisterSettingsRoutesOptions,
): Promise<void> {
  const { db, jwtSecret } = options;
  const auth = createJwtAuthMiddleware({ secret: jwtSecret, db });
  const adminOrTeacher = requireRole(['school_admin', 'teacher']);
  const adminOnly = requireRole(['school_admin']);

  /** Best-effort audit log into admin_audit table. */
  const auditLog = async (
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> => {
    const pool = getPool(db);
    if (!pool) return;
    try {
      await pool.query(
        `INSERT INTO admin_audit (actor_id, action, target_type, target_id, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [actorId, action, targetType, targetId, JSON.stringify(metadata)],
      );
    } catch { /* best-effort */ }
  };

  // ── GET /v1/school/settings ────────────────────────────────────────────────
  app.get(
    '/v1/school/settings',
    { preHandler: [auth, adminOrTeacher] },
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

      // Join tenants + schools for level, then left-join workspace_plans for plan info.
      const { rows } = await pool.query<{
        id: string;
        name: string;
        slug: string;
        level: string;
        plan: string;
        seats: number | null;
        renews_at: Date | null;
        created_at: Date;
      }>(
        `SELECT
           t.id,
           t.name,
           t.slug,
           COALESCE(s.level, 'unknown')         AS level,
           COALESCE(wp.plan, 'free')             AS plan,
           wp.generations_used_this_month        AS seats,
           wp.billing_cycle_started_at           AS renews_at,
           t.created_at
         FROM tenants t
         LEFT JOIN schools s ON s.tenant_id = t.id
         LEFT JOIN workspace_plans wp
           ON wp.workspace_id = $1 AND wp.active = true
         WHERE t.id = $1::uuid
         LIMIT 1`,
        [workspaceId],
      );

      if (rows.length === 0) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'School tidak ditemukan', requestId, retryable: false },
        });
      }

      const row = rows[0]!;
      return reply.status(200).send({
        data: {
          id: row.id,
          name: row.name,
          slug: row.slug,
          level: row.level,
          plan: row.plan,
          seats: row.seats ?? 0,
          renewsAt: row.renews_at ?? null,
          createdAt: row.created_at,
        },
      });
    },
  );

  // ── PATCH /v1/school/settings ──────────────────────────────────────────────
  app.patch(
    '/v1/school/settings',
    { preHandler: [auth, adminOnly] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = getRequestId(request);
      const workspaceId = request.jwtUser?.workspaceId;
      const actorId = request.jwtUser?.userId ?? 'unknown';

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

      const body = (request.body ?? {}) as { name?: string; description?: string };
      const { name } = body;

      if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'name harus berupa string tidak kosong',
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

      // Only name is stored on tenants; description is accepted but currently has no column.
      if (!name) {
        // Nothing to update — return current state.
        const { rows } = await pool.query<{ id: string; name: string; created_at: Date }>(
          `SELECT id, name, created_at FROM tenants WHERE id = $1::uuid LIMIT 1`,
          [workspaceId],
        );
        if (rows.length === 0) {
          return reply.status(404).send({
            error: { code: 'NOT_FOUND', message: 'School tidak ditemukan', requestId, retryable: false },
          });
        }
        const r = rows[0]!;
        return reply.status(200).send({ data: { id: r.id, name: r.name, updatedAt: r.created_at } });
      }

      const { rows } = await pool.query<{ id: string; name: string; updated_at: Date }>(
        `UPDATE tenants
         SET name = $1
         WHERE id = $2::uuid
         RETURNING id, name, now() AS updated_at`,
        [name.trim(), workspaceId],
      );

      if (rows.length === 0) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'School tidak ditemukan', requestId, retryable: false },
        });
      }

      const updated = rows[0]!;

      // Audit log — fire and forget.
      void auditLog(actorId, 'update_school_settings', 'tenant', workspaceId, {
        fields: { name: name.trim() },
      });

      return reply.status(200).send({
        data: {
          id: updated.id,
          name: updated.name,
          updatedAt: updated.updated_at,
        },
      });
    },
  );
}
