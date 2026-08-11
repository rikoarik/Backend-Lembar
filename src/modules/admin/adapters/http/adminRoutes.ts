/**
 * Superadmin HTTP routes — JWT auth, audit-logged.
 *
 * All routes require JWT with role 'superadmin'.
 * New routes: flags, prompts, quality, audit, billing, dashboard.
 */
import { eq, desc, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool, type Database } from '../../../../infrastructure/database/db.js';
import { jwtUsers } from '../../../auth/persistence/jwtUsersSchema.js';
import {
  createJwtAuthMiddleware,
  requireRole,
} from '../../../../common/middleware/jwtMultiRoleAuth.js';
import {
  adminFlags,
  adminPrompts,
  adminQualityReports,
  adminAudit,
  adminBilling,
} from '../../persistence/adminOpsSchema.js';
import type { AdminService } from '../../application/AdminService.js';
import { PasswordResetService } from '../../../auth/application/PasswordResetService.js';
import { tenants } from '../../../../infrastructure/database/schema.js';
import jwt from 'jsonwebtoken';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? req.requestId ?? 'req_unknown';
}

export interface RegisterAdminRoutesOptions {
  service: AdminService;
  db: Database;
  jwtSecret: string;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  options: RegisterAdminRoutesOptions,
): Promise<void> {
  const { service, db, jwtSecret } = options;
  const auth = createJwtAuthMiddleware({ secret: jwtSecret, db });
  const superadmin = requireRole(['superadmin']);
  const passwordResetService = new PasswordResetService(db);

  const auditLog = async (
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown> = {},
  ) => {
    const pool = getPool(db);
    if (!pool) return;
    try {
      await pool.query(
        `INSERT INTO admin_audit (actor_id, action, target_type, target_id, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [actorId, action, targetType, targetId, JSON.stringify(metadata)],
      );
    } catch {
      /* best-effort */
    }
  };

  // ── Dashboard KPI ────────────────────────────────────
  app.get('/v1/admin/dashboard', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const pool = getPool(db);
    if (!pool)
      return reply
        .status(200)
        .send({
          data: {
            users: 0,
            schools: 0,
            jobsActive: 0,
            jobsFailed: 0,
            qualityOpen: 0,
            flagsEnabled: 0,
          },
        });
    const usersRes = await pool.query<{ count: string }>(
      'SELECT count(*)::text as count FROM jwt_users',
    );
    const tenantsRes = await pool.query<{ count: string }>(
      'SELECT count(*)::text as count FROM tenants',
    );
    const jobsRes = await pool.query<{ count: string }>(
      'SELECT count(*)::text as count FROM spike_jobs WHERE status IN ($1, $2)',
      ['running', 'queued'],
    );
    const jobsFailedRes = await pool.query<{ count: string }>(
      'SELECT count(*)::text as count FROM spike_jobs WHERE status = $1',
      ['failed'],
    );
    const qualityRes = await pool.query<{ count: string }>(
      "SELECT count(*)::text as count FROM admin_quality_reports WHERE status IN ('open', 'triaged')",
    );
    const flagsRes = await pool.query<{ count: string }>(
      'SELECT count(*)::text as count FROM admin_flags WHERE enabled = true',
    );
    await auditLog(request.jwtUser!.userId, 'dashboard.read', 'dashboard', 'overview');
    return reply.status(200).send({
      data: {
        users: Number(usersRes.rows[0]?.count ?? 0),
        schools: Number(tenantsRes.rows[0]?.count ?? 0),
        jobsActive: Number(jobsRes.rows[0]?.count ?? 0),
        jobsFailed: Number(jobsFailedRes.rows[0]?.count ?? 0),
        qualityOpen: Number(qualityRes.rows[0]?.count ?? 0),
        flagsEnabled: Number(flagsRes.rows[0]?.count ?? 0),
      },
    });
  });

  app.get(
    '/v1/admin/dashboard/trends',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const pool = getPool(db);
      if (!pool) return reply.status(200).send({ data: { jobs: [], quality: [] } });

      const jobsTrend = await pool.query<{ day: string; count: string }>(
        `SELECT date_trunc('day', created_at)::date::text as day, count(*)::text as count
       FROM spike_jobs
       WHERE created_at >= now() - interval '7 days'
       GROUP BY 1 ORDER BY 1`,
      );
      const qualityTrend = await pool.query<{ day: string; count: string }>(
        `SELECT date_trunc('day', created_at)::date::text as day, count(*)::text as count
       FROM admin_quality_reports
       WHERE created_at >= now() - interval '7 days'
       GROUP BY 1 ORDER BY 1`,
      );

      await auditLog(request.jwtUser!.userId, 'dashboard.trends.read', 'dashboard', 'trends');
      return reply.status(200).send({
        data: {
          jobs: jobsTrend.rows.map((r) => ({ day: r.day, count: Number(r.count) })),
          quality: qualityTrend.rows.map((r) => ({ day: r.day, count: Number(r.count) })),
        },
      });
    },
  );

  // ── Accounts ──────────────────────────────────────────
  app.get('/v1/admin/accounts', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const q = request.query as Record<string, string>;
    const pool = getPool(db);
    if (!pool)
      return reply.status(200).send({ data: [], meta: { total: 0, page: 1, limit: 50, pages: 1 } });

    const search = q['q']?.trim() ?? '';
    const role = q['role']?.trim() ?? '';
    const status = q['status']?.trim() ?? '';
    const page = Math.max(1, parseInt(q['page'] ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q['limit'] ?? '50', 10)));
    const offset = (page - 1) * limit;

    const params: unknown[] = [];
    let idx = 1;

    const whereClauses: string[] = ['1=1'];

    if (search) {
      whereClauses.push(
        `(jw.email ILIKE $${idx} OR jw.name ILIKE $${idx} OR jw.username ILIKE $${idx})`,
      );
      params.push(`%${search}%`);
      idx++;
    }
    if (role) {
      whereClauses.push(`$${idx} = ANY(jw.roles)`);
      params.push(role);
      idx++;
    }
    if (status === 'ditangguhkan') {
      whereClauses.push(`jw.suspended_at IS NOT NULL`);
    } else if (status === 'baru') {
      whereClauses.push(`jw.created_at > now() - interval '7 days' AND jw.suspended_at IS NULL`);
    } else if (status === 'aktif') {
      whereClauses.push(`jw.created_at <= now() - interval '7 days' AND jw.suspended_at IS NULL`);
    }

    const where = whereClauses.join(' AND ');

    const countRes = await pool.query(
      `SELECT COUNT(*) as total
       FROM jwt_users jw
       LEFT JOIN tenants t ON t.id = jw.workspace_id
       LEFT JOIN admin_billing ab ON ab.tenant_id = jw.workspace_id::text
       WHERE ${where}`,
      params,
    );
    const total = parseInt((countRes.rows[0] as any).total, 10);

    const dataRes = await pool.query(
      `SELECT jw.id, jw.email, jw.name, jw.username, jw.roles,
         jw.workspace_id, t.name as school_name, jw.created_at,
         CASE WHEN jw.suspended_at IS NOT NULL THEN 'ditangguhkan'
              WHEN jw.created_at > now() - interval '7 days' THEN 'baru'
              ELSE 'aktif' END as status
       FROM jwt_users jw
       LEFT JOIN tenants t ON t.id = jw.workspace_id
       LEFT JOIN admin_billing ab ON ab.tenant_id = jw.workspace_id::text
       WHERE ${where}
       ORDER BY jw.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    );

    const data = dataRes.rows.map((r: any) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      displayName: r.name,
      username: r.username,
      role: r.roles?.[0] ?? 'subscriber',
      roles: r.roles ?? [],
      status: r.status,
      school: r.school_name ?? '—',
      workspaceId: r.workspace_id,
      createdAt: r.created_at,
    }));

    await auditLog(request.jwtUser!.userId, 'account.list', 'user', 'list', {
      page,
      limit,
      search: Boolean(search),
      filters: { role, status },
    });
    return reply.status(200).send({
      data,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  });

  app.get('/v1/admin/accounts/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool)
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });

    const res = await pool.query(
      `
      SELECT
        jw.id, jw.email, jw.name, jw.username, jw.phone, jw.roles,
        jw.workspace_id, jw.created_at, jw.updated_at, jw.last_login_at,
        t.name as school_name, t.slug as school_slug,
        ab.state as billing_state, ab.plan as billing_plan,
        ab.seats as billing_seats, ab.renews_at as billing_renews_at,
        CASE WHEN jw.suspended_at IS NOT NULL THEN 'ditangguhkan'
             WHEN jw.created_at > now() - interval '7 days' THEN 'baru'
             ELSE 'aktif' END as status,
        (SELECT COUNT(*) FROM ai_jobs_audit WHERE workspace_id = jw.workspace_id::text) as jobs_total,
        (SELECT COUNT(*) FROM quota_reservations WHERE workspace_id = jw.workspace_id::text AND state = 'committed') as quota_used,
        (SELECT json_agg(json_build_object(
          'id', aa.id, 'action', aa.action, 'at', aa.created_at, 'by', aa.actor_email
        ) ORDER BY aa.created_at DESC) FROM admin_audit aa
          WHERE aa.target_id = jw.id::text LIMIT 10) as audit_log
      FROM jwt_users jw
      LEFT JOIN tenants t ON t.id = jw.workspace_id
      LEFT JOIN admin_billing ab ON ab.tenant_id = jw.workspace_id::text
      WHERE jw.id = $1
    `,
      [id],
    );

    if (!res.rows[0])
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });
    const r = res.rows[0] as any;

    await auditLog(request.jwtUser!.userId, 'account.read', 'user', id);
    return reply.status(200).send({
      data: {
        // Identitas
        id: r.id,
        email: r.email,
        name: r.name,
        username: r.username,
        phone: r.phone ?? null,
        // Status & Akses
        roles: r.roles ?? [],
        role: r.roles?.[0] ?? 'subscriber',
        status: r.status,
        // Sekolah & Workspace
        school: r.school_name ?? '—',
        schoolSlug: r.school_slug ?? null,
        workspaceId: r.workspace_id ?? null,
        // Billing workspace
        billing: {
          state: r.billing_state ?? null,
          plan: r.billing_plan ?? null,
          seats: r.billing_seats ?? null,
          renewsAt: r.billing_renews_at ?? null,
        },
        // Aktivitas
        stats: {
          jobsTotal: parseInt(r.jobs_total ?? '0', 10),
          quotaUsed: parseInt(r.quota_used ?? '0', 10),
        },
        // Timestamps
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        lastLoginAt: r.last_login_at ?? null,
        // History aksi admin (max 10)
        auditLog: r.audit_log ?? [],
      },
    });
  });

  app.patch(
    '/v1/admin/accounts/:id',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { name?: string; phone?: string } | null;
      if (!body?.name && !body?.phone)
        return reply
          .status(400)
          .send({ error: { code: 'VALIDATION_FAILED', message: 'name or phone required' } });

      const pool = getPool(db);
      if (!pool)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

      const setClauses: string[] = ['updated_at = now()'];
      const params: unknown[] = [];
      let idx = 1;
      if (body.name) {
        setClauses.push(`name = $${idx++}`);
        params.push(body.name);
      }
      if (body.phone !== undefined) {
        setClauses.push(`phone = $${idx++}`);
        params.push(body.phone || null);
      }
      params.push(id);

      const res = await pool.query(
        `UPDATE jwt_users SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING id, email, name, phone, updated_at`,
        params,
      );
      if (!res.rows[0])
        return reply
          .status(404)
          .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });

      const actor = request.jwtUser!;
      await auditLog(actor.userId, 'account.update', 'user', id, {
        name: body.name,
        phone: body.phone,
      });
      return reply.status(200).send({ data: res.rows[0] });
    },
  );

  app.patch(
    '/v1/admin/accounts/:id/roles',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { roles?: string[] } | null;
      if (!body?.roles || !Array.isArray(body.roles))
        return reply
          .status(400)
          .send({ error: { code: 'VALIDATION_FAILED', message: 'roles array required' } });

      const pool = getPool(db);
      if (!pool)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

      await pool.query('UPDATE jwt_users SET roles = $1::text[] WHERE id = $2', [body.roles, id]);
      const user = request.jwtUser!;
      await auditLog(user.userId, 'account.roles', 'user', id, { roles: body.roles });
      return reply.status(200).send({ data: { id, roles: body.roles } });
    },
  );

  // ── Plan Catalog ─────────────────────────────────────
  app.get('/v1/admin/plans', { preHandler: [auth, superadmin] }, async (_request, reply) => {
    const pool = getPool(db);
    if (!pool)
      return reply
        .status(500)
        .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });
    const res = await pool.query(
      `SELECT key,display_name,price_amount,currency,billing_period,token_monthly_limit,features,active,revision,updated_at,updated_by
       FROM plan_catalog ORDER BY CASE key WHEN 'free' THEN 0 ELSE 1 END`,
    );
    return reply.status(200).send({ data: res.rows });
  });

  app.patch('/v1/admin/plans/:key', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { key } = request.params as { key: string };
    if (key !== 'free' && key !== 'pro') {
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Plan tidak ditemukan.' } });
    }
    const pool = getPool(db);
    if (!pool)
      return reply
        .status(500)
        .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return reply
        .status(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'Request body kosong.' } });
    }

    // Trust-boundary validation
    const { displayName, priceAmount, billingPeriod, tokenMonthlyLimit, features, active } =
      body as {
        displayName?: unknown;
        priceAmount?: unknown;
        billingPeriod?: unknown;
        tokenMonthlyLimit?: unknown;
        features?: unknown;
        active?: unknown;
      };
    if (
      displayName !== undefined &&
      (typeof displayName !== 'string' || displayName.trim().length === 0)
    ) {
      return reply
        .status(400)
        .send({
          error: { code: 'VALIDATION_FAILED', message: 'displayName harus string tidak kosong.' },
        });
    }
    if (
      priceAmount !== undefined &&
      (!Number.isInteger(priceAmount) || (priceAmount as number) < 0)
    ) {
      return reply
        .status(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'priceAmount harus integer >= 0.' } });
    }
    if (billingPeriod !== undefined && billingPeriod !== null && billingPeriod !== 'monthly') {
      return reply
        .status(400)
        .send({
          error: { code: 'VALIDATION_FAILED', message: 'billingPeriod harus monthly atau null.' },
        });
    }
    if (
      tokenMonthlyLimit !== undefined &&
      tokenMonthlyLimit !== null &&
      (!Number.isInteger(tokenMonthlyLimit) || (tokenMonthlyLimit as number) < 0)
    ) {
      return reply
        .status(400)
        .send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'tokenMonthlyLimit harus integer >= 0 atau null.',
          },
        });
    }
    if (features !== undefined && !Array.isArray(features)) {
      return reply
        .status(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'features harus array.' } });
    }
    if (active !== undefined && typeof active !== 'boolean') {
      return reply
        .status(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'active harus boolean.' } });
    }

    // Optimistic concurrency via required If-Match: <revision>.
    const ifMatch = request.headers['if-match'] as string | undefined;
    const expectedRevision = ifMatch && /^\d+$/.test(ifMatch) ? Number(ifMatch) : null;
    if (expectedRevision === null || expectedRevision < 1) {
      return reply
        .status(400)
        .send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'If-Match revision wajib berupa integer >= 1.',
          },
        });
    }

    const current = await pool.query<{ revision: number }>(
      'SELECT revision FROM plan_catalog WHERE key=$1',
      [key],
    );
    if (!current.rows[0])
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Plan tidak ditemukan.' } });

    const sets: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;
    if (displayName !== undefined) {
      sets.push(`display_name=$${idx++}`);
      vals.push(displayName);
    }
    if (priceAmount !== undefined) {
      sets.push(`price_amount=$${idx++}`);
      vals.push(priceAmount);
    }
    if (billingPeriod !== undefined) {
      sets.push(`billing_period=$${idx++}`);
      vals.push(billingPeriod);
    }
    if (tokenMonthlyLimit !== undefined) {
      sets.push(`token_monthly_limit=$${idx++}`);
      vals.push(tokenMonthlyLimit);
    }
    if (features !== undefined) {
      sets.push(`features=$${idx++}`);
      vals.push(JSON.stringify(features));
    }
    if (active !== undefined) {
      sets.push(`active=$${idx++}`);
      vals.push(active);
    }

    if (sets.length === 0)
      return reply
        .status(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'Tidak ada field yang diubah.' } });

    sets.push(`revision=revision+1`, `updated_at=now()`, `updated_by=$${idx++}`);
    vals.push(request.jwtUser!.userId);
    const keyIndex = idx++;
    vals.push(key);
    const revisionIndex = idx;
    vals.push(expectedRevision);

    const res = await pool.query(
      `UPDATE plan_catalog SET ${sets.join(',')} WHERE key=$${keyIndex} AND revision=$${revisionIndex} RETURNING *`,
      vals,
    );
    if (!res.rows[0]) {
      return reply
        .status(409)
        .send({ error: { code: 'CONFLICT', message: 'Revision plan sudah berubah.' } });
    }
    const actor = request.jwtUser!;
    await auditLog(actor.userId, 'plan_catalog.update', 'plan_catalog', key, { ...body });
    return reply.status(200).send({ data: res.rows[0] });
  });

  app.post(
    '/v1/admin/accounts/:id/suspend',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const pool = getPool(db);
      if (!pool)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

      const res = await pool.query(
        `UPDATE jwt_users
       SET suspended_at = now(), suspended_reason = 'superadmin', updated_at = now()
       WHERE id = $1
       RETURNING workspace_id`,
        [id],
      );
      if (!res.rows[0])
        return reply
          .status(404)
          .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });

      const workspaceId = (res.rows[0] as any).workspace_id;
      const user = request.jwtUser!;
      await auditLog(user.userId, 'account.suspend', 'user', id, { workspaceId });
      return reply.status(200).send({ data: { id, suspended: true } });
    },
  );

  // ── Bulk operations ──────────────────────────────────────
  app.post(
    '/v1/admin/accounts/bulk/suspend',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const body = request.body as { ids?: string[] } | null;
      if (!body?.ids || !Array.isArray(body.ids) || body.ids.length === 0)
        return reply
          .status(400)
          .send({ error: { code: 'VALIDATION_FAILED', message: 'ids array required' } });

      const pool = getPool(db);
      if (!pool)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

      const results: { id: string; success: boolean; error?: string }[] = [];
      const actor = request.jwtUser!;

      for (const id of body.ids) {
        try {
          const res = await pool.query(
            `UPDATE jwt_users
           SET suspended_at = now(), suspended_reason = 'superadmin', updated_at = now()
           WHERE id = $1
           RETURNING workspace_id`,
            [id],
          );
          if (!res.rows[0]) {
            results.push({ id, success: false, error: 'Not found' });
            continue;
          }
          const workspaceId = (res.rows[0] as any).workspace_id;
          await auditLog(actor.userId, 'account.suspend', 'user', id, { workspaceId, bulk: true });
          results.push({ id, success: true });
        } catch {
          results.push({ id, success: false, error: 'Internal error' });
        }
      }

      const succeeded = results.filter((r) => r.success).length;
      return reply
        .status(200)
        .send({ data: { results, succeeded, failed: results.length - succeeded } });
    },
  );

  app.post(
    '/v1/admin/accounts/bulk/unsuspend',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const body = request.body as { ids?: string[] } | null;
      if (!body?.ids || !Array.isArray(body.ids) || body.ids.length === 0)
        return reply
          .status(400)
          .send({ error: { code: 'VALIDATION_FAILED', message: 'ids array required' } });

      const pool = getPool(db);
      if (!pool)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

      const results: { id: string; success: boolean; error?: string }[] = [];
      const actor = request.jwtUser!;

      for (const id of body.ids) {
        try {
          const res = await pool.query(
            `UPDATE jwt_users
           SET suspended_at = NULL, suspended_reason = NULL, updated_at = now()
           WHERE id = $1
           RETURNING workspace_id`,
            [id],
          );
          if (!res.rows[0]) {
            results.push({ id, success: false, error: 'Not found' });
            continue;
          }
          const workspaceId = (res.rows[0] as any).workspace_id;
          await auditLog(actor.userId, 'account.unsuspend', 'user', id, {
            workspaceId,
            bulk: true,
          });
          results.push({ id, success: true });
        } catch {
          results.push({ id, success: false, error: 'Internal error' });
        }
      }

      const succeeded = results.filter((r) => r.success).length;
      return reply
        .status(200)
        .send({ data: { results, succeeded, failed: results.length - succeeded } });
    },
  );

  app.post(
    '/v1/admin/accounts/bulk/delete',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const body = request.body as { ids?: string[] } | null;
      if (!body?.ids || !Array.isArray(body.ids) || body.ids.length === 0)
        return reply
          .status(400)
          .send({ error: { code: 'VALIDATION_FAILED', message: 'ids array required' } });

      const pool = getPool(db);
      if (!pool)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

      const actor = request.jwtUser!;
      const results: { id: string; success: boolean; error?: string }[] = [];

      for (const id of body.ids) {
        try {
          if (actor.userId === id) {
            results.push({ id, success: false, error: 'Tidak bisa hapus akun sendiri' });
            continue;
          }
          const res = await pool.query('SELECT email, name, roles FROM jwt_users WHERE id = $1', [
            id,
          ]);
          if (!res.rows[0]) {
            results.push({ id, success: false, error: 'Not found' });
            continue;
          }
          const target = res.rows[0] as any;
          if (target.roles?.includes('superadmin')) {
            results.push({ id, success: false, error: 'Tidak bisa hapus superadmin' });
            continue;
          }
          await pool.query('DELETE FROM jwt_users WHERE id = $1', [id]);
          await auditLog(actor.userId, 'account.delete', 'user', id, {
            email: target.email,
            bulk: true,
          });
          results.push({ id, success: true });
        } catch {
          results.push({ id, success: false, error: 'Internal error' });
        }
      }

      const succeeded = results.filter((r) => r.success).length;
      return reply
        .status(200)
        .send({ data: { results, succeeded, failed: results.length - succeeded } });
    },
  );

  app.post(
    '/v1/admin/accounts/:id/unsuspend',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const pool = getPool(db);
      if (!pool)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

      const res = await pool.query(
        `UPDATE jwt_users
       SET suspended_at = NULL, suspended_reason = NULL, updated_at = now()
       WHERE id = $1
       RETURNING workspace_id`,
        [id],
      );
      if (!res.rows[0])
        return reply
          .status(404)
          .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });

      const workspaceId = (res.rows[0] as any).workspace_id;
      const user = request.jwtUser!;
      await auditLog(user.userId, 'account.unsuspend', 'user', id, { workspaceId });
      return reply.status(200).send({ data: { id, suspended: false } });
    },
  );

  app.post(
    '/v1/admin/accounts/:id/impersonate',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const pool = getPool(db);
      if (!pool)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

      // Fetch target user
      const res = await pool.query(
        `SELECT id, email, name, roles, workspace_id FROM jwt_users WHERE id = $1`,
        [id],
      );
      if (!res.rows[0])
        return reply
          .status(404)
          .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });

      const target = res.rows[0] as any;
      const actingUser = request.jwtUser!;

      // Sign a short-lived impersonation token (1 hour) using jsonwebtoken
      const token = jwt.sign(
        {
          userId: target.id,
          email: target.email,
          roles: target.roles,
          workspaceId: target.workspace_id,
          impersonatedBy: actingUser.userId,
        },
        jwtSecret,
        { expiresIn: '1h' },
      );

      await auditLog(actingUser.userId, 'account.impersonate', 'user', id, {
        targetEmail: target.email,
        impersonatedBy: actingUser.userId,
      });

      const roles: string[] = target.roles ?? [];
      const homePath = roles.includes('superadmin')
        ? '/ops'
        : roles.includes('school_admin')
          ? '/school'
          : '/app';

      return reply.status(200).send({
        data: {
          token,
          targetId: target.id,
          targetEmail: target.email,
          targetName: target.name,
          expiresIn: 3600,
          homePath,
        },
      });
    },
  );

  app.post(
    '/v1/admin/accounts/:id/reset-password',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const pool = getPool(db);
      if (!pool)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

      const res = await pool.query('SELECT email FROM jwt_users WHERE id = $1', [id]);
      if (!res.rows[0])
        return reply
          .status(404)
          .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });

      const issued = await passwordResetService.issue(id);
      const resetUrl = `/reset-password?token=${encodeURIComponent(issued.token)}`;
      const user = request.jwtUser!;
      await auditLog(user.userId, 'account.reset_password', 'user', id, {
        email: (res.rows[0] as any).email,
      });
      return reply.status(200).send({
        data: {
          id,
          sent: true,
          token: issued.token,
          resetUrl,
          expiresAt: issued.expiresAt.toISOString(),
        },
      });
    },
  );

  app.delete(
    '/v1/admin/accounts/:id',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const pool = getPool(db);
      if (!pool)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

      // Cegah hapus diri sendiri
      const actingUser = request.jwtUser!;
      if (actingUser.userId === id) {
        return reply
          .status(400)
          .send({
            error: { code: 'VALIDATION_FAILED', message: 'Tidak bisa menghapus akun sendiri' },
          });
      }

      const res = await pool.query('SELECT email, name, roles FROM jwt_users WHERE id = $1', [id]);
      if (!res.rows[0])
        return reply
          .status(404)
          .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });

      const target = res.rows[0] as any;

      // Cegah hapus superadmin lain
      if (target.roles?.includes('superadmin')) {
        return reply
          .status(403)
          .send({ error: { code: 'FORBIDDEN', message: 'Tidak bisa menghapus akun superadmin' } });
      }

      await pool.query('DELETE FROM jwt_users WHERE id = $1', [id]);
      await auditLog(actingUser.userId, 'account.delete', 'user', id, {
        email: target.email,
        name: target.name,
      });
      return reply.status(200).send({ data: { id, deleted: true, email: target.email } });
    },
  );

  app.post(
    '/v1/admin/accounts/invite',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const body = request.body as { email: string; name?: string; role?: string } | null;
      if (!body?.email)
        return reply
          .status(400)
          .send({ error: { code: 'VALIDATION_FAILED', message: 'email required' } });
      if (!body)
        return reply
          .status(400)
          .send({ error: { code: 'VALIDATION_FAILED', message: 'body required' } });
      const inputEmail = String(body.email || '')
        .trim()
        .toLowerCase();
      const inputName = body.name || inputEmail;
      const inputRole = body.role || 'subscriber';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inputEmail))
        return reply
          .status(400)
          .send({ error: { code: 'VALIDATION_FAILED', message: 'email tidak valid' } });
      if (!['superadmin', 'school_admin', 'teacher', 'subscriber'].includes(inputRole))
        return reply
          .status(400)
          .send({ error: { code: 'VALIDATION_FAILED', message: 'role tidak valid' } });

      const pool = getPool(db);
      if (!pool)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

      const existing = await pool.query('SELECT id FROM jwt_users WHERE email = $1', [inputEmail]);
      if (existing.rows[0])
        return reply
          .status(409)
          .send({ error: { code: 'CONFLICT', message: 'Email sudah terdaftar' } });

      const parts = inputEmail.split('@');
      const slugBase =
        (parts[0] || 'user')
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '') || 'user';
      const slug = `${slugBase}-${Date.now().toString(36)}`;
      const tenantRes = await pool.query(
        `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
        ['invited-' + slug, inputName + ' Workspace'],
      );
      const tenantId = tenantRes.rows[0]?.id ?? null;

      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO jwt_users (email, name, username, password_hash, needs_password_setup, roles, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7)
       RETURNING id`,
        [inputEmail, inputName, slug, null, true, [inputRole], tenantId],
      );
      const accountId = inserted.rows[0]?.id;
      if (!accountId)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create account' } });

      const issued = await passwordResetService.issue(accountId);
      const welcomeUrl = `/set-password?token=${encodeURIComponent(issued.token)}`;
      const user = request.jwtUser!;
      await auditLog(user.userId, 'account.invite', 'user', accountId, {
        role: inputRole,
        email: inputEmail,
      });
      return reply.status(201).send({
        data: {
          invited: true,
          accountId,
          token: issued.token,
          welcomeUrl,
          expiresAt: issued.expiresAt.toISOString(),
        },
      });
    },
  );

  // ── Jobs ──────────────────────────────────────────────
  app.get('/v1/admin/jobs', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const q = request.query as Record<string, string>;
    const pool = getPool(db);
    if (!pool)
      return reply.status(200).send({ data: [], meta: { total: 0, page: 1, limit: 50, pages: 1 } });

    const page = Math.max(1, parseInt(q['page'] ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q['limit'] ?? '50', 10)));
    const offset = (page - 1) * limit;
    const status = q['status']?.trim() ?? '';
    const tenant = q['tenant']?.trim() ?? '';
    const type = q['type']?.trim() ?? '';
    const search = q['q']?.trim() ?? '';

    const whereClauses: string[] = ['1=1'];
    const params: unknown[] = [];
    let idx = 1;

    if (status) {
      whereClauses.push(`sj.status = $${idx++}`);
      params.push(status);
    }
    if (tenant) {
      whereClauses.push(`sj.workspace_id = $${idx++}`);
      params.push(tenant);
    }
    if (type) {
      whereClauses.push(`sj.kind = $${idx++}`);
      params.push(type);
    }
    if (search) {
      whereClauses.push(`(sj.id ILIKE $${idx} OR sj.kind ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const where = whereClauses.join(' AND ');

    const countRes = await pool.query(
      `SELECT COUNT(*) as total FROM spike_jobs sj WHERE ${where}`,
      params,
    );
    const total = parseInt((countRes.rows[0] as any).total, 10);

    const dataRes = await pool.query(
      `SELECT sj.id, sj.kind, sj.status, sj.workspace_id, sj.attempt, sj.created_at, sj.updated_at,
              t.name as tenant_name
       FROM spike_jobs sj
       LEFT JOIN tenants t ON t.id = sj.workspace_id::uuid
       WHERE ${where}
       ORDER BY sj.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    );

    const data = dataRes.rows.map((r: any) => ({
      id: r.id,
      type: r.kind,
      status: r.status,
      tenant: r.tenant_name ?? r.workspace_id ?? '—',
      workspaceId: r.workspace_id,
      attempt: r.attempt ?? 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return reply
      .status(200)
      .send({ data, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
  });

  app.get('/v1/admin/jobs/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool)
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Job not found' } });
    const res = await pool.query('SELECT * FROM spike_jobs WHERE id = $1', [id]);
    if (!res.rows[0])
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Job not found' } });
    await auditLog(request.jwtUser!.userId, 'job.read', 'job', id);
    return reply.status(200).send({ data: res.rows[0] });
  });

  app.post(
    '/v1/admin/jobs/:id/retry',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const pool = getPool(db);
      if (!pool)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });
      const res = await pool.query('SELECT id, status FROM spike_jobs WHERE id = $1', [id]);
      if (!res.rows[0])
        return reply
          .status(404)
          .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Job not found' } });
      const jobStatus = (res.rows[0] as any).status;
      if (jobStatus !== 'failed' && jobStatus !== 'dead_letter') {
        return reply
          .status(400)
          .send({
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Only failed or dead_letter jobs can be retried',
            },
          });
      }
      await pool.query('UPDATE spike_jobs SET status = $1, attempt = attempt + 1 WHERE id = $2', [
        'queued',
        id,
      ]);
      const user = request.jwtUser!;
      await auditLog(user.userId, 'job.retry', 'job', id, {});
      return reply.status(200).send({ data: { id, retried: true } });
    },
  );

  // ── Quality Reports ──────────────────────────────────
  app.post('/v1/admin/quality-reports', { preHandler: [auth] }, async (request, reply) => {
    const body = request.body as {
      reason?: string;
      notes?: string;
      assessmentId?: string;
      questionId?: string;
    } | null;
    const reason = (body?.reason ?? '').trim();
    const notes = (body?.notes ?? '').toString();
    // reason required; allow reason-only (notes optional)
    if (!reason) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'reason wajib diisi' },
      });
    }
    if (reason.length > 200) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'reason terlalu panjang (maks 200)' },
      });
    }

    const user = request.jwtUser!;
    // workspaceId: prefer JWT, fall back to x-workspace-id header (BFF injects)
    const headerWs = (request.headers['x-workspace-id'] as string | undefined) ?? '';
    const workspaceId = user.workspaceId ?? headerWs ?? '';
    if (!workspaceId) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'workspaceId wajib diisi (login di workspace)',
        },
      });
    }

    // assessmentVersionId: store the assessment reference (compound: asm/question)
    const assessmentVersionId = (body?.assessmentId ?? '').toString().slice(0, 200);
    const reporter = user.email || user.userId;
    const notePayload = (body?.questionId ? `q=${body.questionId}; ` : '') + notes;

    const pool = getPool(db);
    if (!pool) {
      return reply.status(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Database not available' },
      });
    }

    const result = await pool.query(
      `INSERT INTO admin_quality_reports (workspace_id, assessment_version_id, reporter, reason, status, notes)
       VALUES ($1, $2, $3, $4, 'open', $5)
       RETURNING id, reason, status, reporter, notes, workspace_id, created_at`,
      [workspaceId, assessmentVersionId, reporter, reason, notePayload.slice(0, 1000)],
    );
    const row = result.rows[0] as any;

    await auditLog(user.userId, 'quality.create', 'report', row.id, {
      reason,
      workspaceId,
      hasAssessment: Boolean(assessmentVersionId),
    });

    return reply.status(201).send({
      data: {
        id: row.id,
        reason: row.reason,
        status: row.status,
        reporter: row.reporter,
        notes: row.notes ?? '',
        workspaceId: row.workspace_id,
        createdAt: new Date(row.created_at).toISOString(),
      },
    });
  });

  app.get(
    '/v1/admin/quality-reports',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const q = request.query as Record<string, string>;
      const pool = getPool(db);
      if (!pool)
        return reply
          .status(200)
          .send({ data: [], meta: { total: 0, page: 1, limit: 50, pages: 1 } });

      const page = Math.max(1, parseInt(q['page'] ?? '1', 10));
      const limit = Math.min(100, Math.max(1, parseInt(q['limit'] ?? '50', 10)));
      const offset = (page - 1) * limit;
      const status = q['status']?.trim() ?? '';
      const search = q['q']?.trim() ?? '';

      const whereClauses: string[] = ['1=1'];
      const params: unknown[] = [];
      let idx = 1;

      if (status) {
        whereClauses.push(`qr.status = $${idx++}`);
        params.push(status);
      }
      if (search) {
        whereClauses.push(`(qr.reason ILIKE $${idx} OR qr.reporter ILIKE $${idx})`);
        params.push(`%${search}%`);
        idx++;
      }

      const where = whereClauses.join(' AND ');

      const countRes = await pool.query(
        `SELECT COUNT(*) as total FROM admin_quality_reports qr WHERE ${where}`,
        params,
      );
      const total = parseInt((countRes.rows[0] as any).total, 10);

      const dataRes = await pool.query(
        `SELECT qr.id, qr.reason, qr.status, qr.reporter, qr.notes, qr.workspace_id, qr.created_at
       FROM admin_quality_reports qr
       WHERE ${where}
       ORDER BY qr.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      );

      await auditLog(request.jwtUser!.userId, 'quality.list', 'report', 'list', {
        page,
        limit,
        search: Boolean(search),
        filters: { status },
      });

      return reply.status(200).send({
        data: dataRes.rows.map((r: any) => ({
          id: r.id,
          reason: r.reason,
          status: r.status,
          reporter: r.reporter,
          notes: r.notes ?? '',
          workspaceId: r.workspace_id,
          createdAt: new Date(r.created_at).toISOString(),
        })),
        meta: { total, page, limit, pages: Math.ceil(total / limit) },
      });
    },
  );

  app.patch(
    '/v1/admin/quality-reports/:id',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { status?: string; notes?: string } | null;
      // allow notes-only update (no status required when only notes provided)
      if (!body?.status && body?.notes === undefined)
        return reply
          .status(400)
          .send({ error: { code: 'VALIDATION_FAILED', message: 'status or notes required' } });

      await db
        .update(adminQualityReports)
        .set({ status: body.status, notes: body.notes ?? '', updatedAt: new Date() })
        .where(eq(adminQualityReports.id, id));

      const user = request.jwtUser!;
      await auditLog(user.userId, 'quality.update', 'report', id, { status: body.status });
      return reply.status(200).send({ data: { id, status: body.status } });
    },
  );

  app.get(
    '/v1/admin/quality-reports/:id',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const pool = getPool(db);
      if (!pool)
        return reply
          .status(404)
          .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Report not found' } });
      const res = await pool.query('SELECT * FROM admin_quality_reports WHERE id = $1', [id]);
      if (!res.rows[0])
        return reply
          .status(404)
          .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Report not found' } });
      await auditLog(request.jwtUser!.userId, 'quality.read', 'report', id);
      const r = res.rows[0] as any;
      return reply.status(200).send({
        data: {
          id: r.id,
          reason: r.reason,
          status: r.status,
          reporter: r.reporter,
          notes: r.notes,
          workspaceId: r.workspace_id,
          createdAt: r.created_at,
        },
      });
    },
  );

  // ── Flags ─────────────────────────────────────────────
  app.get('/v1/admin/flags', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: [] });
    const result = await pool.query(
      `SELECT id, key, description, enabled::text, scope, created_at, updated_at FROM admin_flags ORDER BY created_at DESC`,
    );
    await auditLog(request.jwtUser!.userId, 'flag.list', 'flag', 'list');
    return reply
      .status(200)
      .send({ data: result.rows.map((r: any) => ({ ...r, enabled: r.enabled === 'true' })) });
  });

  app.get('/v1/admin/flags/:key', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const pool = getPool(db);
    if (!pool)
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Flag tidak ditemukan' } });
    const res = await pool.query(
      `SELECT id, key, description, enabled::text, scope, created_at, updated_at FROM admin_flags WHERE key = $1`,
      [key],
    );
    if (!res.rows[0])
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Flag tidak ditemukan' } });
    await auditLog(request.jwtUser!.userId, 'flag.read', 'flag', key);
    const r = res.rows[0] as any;
    return reply.status(200).send({ data: { ...r, enabled: r.enabled === 'true' } });
  });

  app.delete('/v1/admin/flags/:key', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const user = request.jwtUser!;
    const [flag] = await db.select().from(adminFlags).where(eq(adminFlags.key, key)).limit(1);
    if (!flag)
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Flag tidak ditemukan' } });
    await db.delete(adminFlags).where(eq(adminFlags.key, key));
    await auditLog(user.userId, 'flag.delete', 'flag', key, { key });
    return reply.status(200).send({ data: { key, deleted: true } });
  });

  app.patch(
    '/v1/admin/flags/:key/toggle',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const { key } = request.params as { key: string };
      const user = request.jwtUser!;
      const [flag] = await db.select().from(adminFlags).where(eq(adminFlags.key, key)).limit(1);
      if (!flag)
        return reply
          .status(404)
          .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Flag tidak ditemukan' } });

      const newEnabled = !flag.enabled;
      await db
        .update(adminFlags)
        .set({ enabled: newEnabled, updatedAt: new Date() })
        .where(eq(adminFlags.id, flag.id));
      await auditLog(user.userId, 'flag.toggle', 'flag', key, { enabled: newEnabled });

      return reply.status(200).send({ data: { key, enabled: newEnabled } });
    },
  );

  app.post('/v1/admin/flags', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const body = request.body as { key?: string; description?: string; scope?: string } | null;
    if (!body?.key)
      return reply
        .status(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'key required' } });
    const user = request.jwtUser!;
    const [created] = await db
      .insert(adminFlags)
      .values({
        key: body.key,
        description: body.description ?? '',
        scope: body.scope ?? 'global',
      })
      .returning();
    await auditLog(user.userId, 'flag.create', 'flag', body.key, { scope: body.scope ?? 'global' });
    return reply
      .status(201)
      .send({ data: { key: body.key, enabled: false, scope: body.scope ?? 'global' } });
  });

  app.patch('/v1/admin/flags/:key', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const body = request.body as { description?: string; scope?: string } | null;
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body?.description !== undefined) updates.description = body.description;
    if (body?.scope) updates.scope = body.scope;
    const [updated] = await db
      .update(adminFlags)
      .set(updates)
      .where(eq(adminFlags.key, key))
      .returning();
    if (!updated)
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Flag not found' } });
    const user = request.jwtUser!;
    await auditLog(user.userId, 'flag.update', 'flag', key, body ?? {});
    return reply.status(200).send({ data: { key, ...body } });
  });

  // ── Audit Trail ──────────────────────────────────────
  app.get('/v1/admin/audit', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const q = request.query as Record<string, string>;
    const pool = getPool(db);
    if (!pool)
      return reply.status(200).send({ data: [], meta: { total: 0, page: 1, limit: 50, pages: 1 } });

    const page = Math.max(1, parseInt(q['page'] ?? '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(q['limit'] ?? '50', 10)));
    const offset = (page - 1) * limit;

    const whereClauses: string[] = ['1=1'];
    const params: any[] = [];
    let paramIdx = 1;
    if (q['action']) {
      whereClauses.push(`action = $${paramIdx++}`);
      params.push(q['action']);
    }
    if (q['actor']) {
      whereClauses.push(`(actor_email = $${paramIdx} OR actor_id = $${paramIdx})`);
      params.push(q['actor']);
      paramIdx++;
    }
    if (q['from']) {
      whereClauses.push(`created_at >= $${paramIdx++}`);
      params.push(q['from']);
    }
    if (q['to']) {
      whereClauses.push(`created_at <= $${paramIdx++}`);
      params.push(q['to']);
    }

    const whereClause = 'WHERE ' + whereClauses.join(' AND ');

    const countRes = await pool.query(
      `SELECT COUNT(*) as total FROM admin_audit ${whereClause}`,
      params,
    );
    const total = parseInt((countRes.rows[0] as any).total, 10);

    const result = await pool.query(
      `SELECT id, actor_id, actor_email, action, target_type, target_id, metadata, created_at
       FROM admin_audit ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset],
    );
    await auditLog(request.jwtUser!.userId, 'audit.list', 'audit', 'list', {
      page,
      limit,
      filters: {
        action: q['action'] ?? '',
        actor: Boolean(q['actor']),
        from: q['from'] ?? '',
        to: q['to'] ?? '',
      },
    });
    return reply.status(200).send({
      data: result.rows.map((r: any) => ({
        id: r.id,
        at: new Date(r.created_at)
          .toLocaleString('id-ID', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })
          .replace(/\//g, '-'),
        actor: r.actor_email || r.actor_id,
        action: r.action,
        target: r.target_id,
        metadata: r.metadata,
        targetType: r.target_type,
      })),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  });

  app.get('/v1/admin/audit/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool)
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Audit entry not found' } });
    const res = await pool.query(
      `SELECT aa.id, aa.actor_id, aa.actor_email, aa.action, aa.target_type, aa.target_id, aa.metadata, aa.created_at,
              jw.name as actor_name
       FROM admin_audit aa
       LEFT JOIN jwt_users jw ON (jw.id::text = aa.actor_id OR jw.email = aa.actor_id)
       WHERE aa.id = $1`,
      [id],
    );
    if (!res.rows[0])
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Audit entry not found' } });
    const r = res.rows[0] as any;
    await auditLog(request.jwtUser!.userId, 'audit.read', 'audit', id);
    return reply.status(200).send({
      data: {
        id: r.id,
        actor: r.actor_email || r.actor_id,
        actorName: r.actor_name ?? r.actor_id ?? '',
        action: r.action,
        targetType: r.target_type,
        target: r.target_id,
        metadata: r.metadata ?? {},
        at: new Date(r.created_at).toISOString(),
      },
    });
  });

  // ── Billing ──────────────────────────────────────────
  app.get('/v1/admin/billing', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const q = request.query as Record<string, string>;
    const pool = getPool(db);
    if (!pool)
      return reply.status(200).send({ data: [], meta: { total: 0, page: 1, limit: 50, pages: 1 } });

    const page = Math.max(1, parseInt(q['page'] ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q['limit'] ?? '50', 10)));
    const offset = (page - 1) * limit;
    const state = q['state']?.trim() ?? '';
    const search = q['q']?.trim() ?? '';

    const whereClauses: string[] = ['1=1'];
    const params: unknown[] = [];
    let idx = 1;

    if (state) {
      whereClauses.push(`state = $${idx++}`);
      params.push(state);
    }
    if (search) {
      whereClauses.push(`school_name ILIKE $${idx++}`);
      params.push(`%${search}%`);
    }

    const where = whereClauses.join(' AND ');

    const countRes = await pool.query(
      `SELECT COUNT(*) as total FROM admin_billing WHERE ${where}`,
      params,
    );
    const total = parseInt((countRes.rows[0] as any).total, 10);

    const result = await pool.query(
      `SELECT id, tenant_id, school_name, state, seats::text, plan, renews_at, created_at, updated_at
       FROM admin_billing WHERE ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    );
    await auditLog(request.jwtUser!.userId, 'billing.list', 'billing', 'list', {
      page,
      limit,
      search: Boolean(search),
      filters: { state },
    });
    return reply.status(200).send({
      data: result.rows.map((r: any) => ({
        id: r.id,
        school: r.school_name,
        state: r.state,
        seats: r.seats,
        plan: r.plan,
        renewsAt: r.renews_at ? new Date(r.renews_at).toISOString().slice(0, 10) : '',
        tenantId: r.tenant_id,
      })),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  });

  app.post('/v1/admin/billing', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const body = request.body as {
      tenantId?: string;
      schoolName?: string;
      plan?: string;
      seats?: number;
      state?: string;
      renewsAt?: string;
    } | null;
    if (!body?.tenantId || !body?.schoolName)
      return reply
        .status(400)
        .send({
          error: { code: 'VALIDATION_FAILED', message: 'tenantId and schoolName required' },
        });
    const user = request.jwtUser!;
    const pool = getPool(db);
    if (!pool)
      return reply
        .status(500)
        .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const existing = await pool.query('SELECT id FROM admin_billing WHERE tenant_id = $1', [
      body.tenantId,
    ]);
    if (existing.rows[0])
      return reply
        .status(409)
        .send({
          error: { code: 'CONFLICT', message: 'Billing record already exists for this tenant' },
        });

    const res = await pool.query(
      `INSERT INTO admin_billing (tenant_id, school_name, plan, seats, state, renews_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        body.tenantId,
        body.schoolName,
        body.plan ?? 'free',
        body.seats ?? 0,
        body.state ?? 'active',
        body.renewsAt ?? null,
      ],
    );
    await auditLog(user.userId, 'billing.create', 'billing', (res.rows[0] as any).id, {
      tenantId: body.tenantId,
      plan: body.plan,
    });
    return reply
      .status(201)
      .send({
        data: { id: (res.rows[0] as any).id, tenantId: body.tenantId, schoolName: body.schoolName },
      });
  });

  app.patch('/v1/admin/billing/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { state?: string; plan?: string; seats?: number } | null;
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body?.state) updates.state = body.state;
    if (body?.plan) updates.plan = body.plan;
    if (body?.seats !== undefined) updates.seats = body.seats;

    const [updated] = await db
      .update(adminBilling)
      .set(updates)
      .where(eq(adminBilling.id, id))
      .returning();
    if (!updated)
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Billing tidak ditemukan' } });

    const user = request.jwtUser!;
    await auditLog(user.userId, 'billing.update', 'billing', id, body ?? {});
    return reply.status(200).send({ data: { id, ...body } });
  });

  app.get('/v1/admin/billing/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool)
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Billing not found' } });
    const res = await pool.query('SELECT * FROM admin_billing WHERE id = $1', [id]);
    if (!res.rows[0])
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Billing not found' } });
    const r = res.rows[0] as any;
    await auditLog(request.jwtUser!.userId, 'billing.read', 'billing', id);
    return reply.status(200).send({
      data: {
        id: r.id,
        school: r.school_name,
        state: r.state,
        seats: r.seats,
        plan: r.plan,
        renewsAt: r.renews_at ? new Date(r.renews_at).toISOString().slice(0, 10) : '',
        tenantId: r.tenant_id,
        createdAt: r.created_at,
      },
    });
  });

  // ── Schools / Tenants ──────────────────────────────
  app.get('/v1/admin/schools', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const q = request.query as Record<string, string>;
    const pool = getPool(db);
    if (!pool)
      return reply.status(200).send({ data: [], meta: { total: 0, page: 1, limit: 10, pages: 1 } });

    const page = Math.max(1, parseInt(q['page'] ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q['limit'] ?? '10', 10)));
    const offset = (page - 1) * limit;
    const search = q['q']?.trim() ?? '';
    const plan = q['plan']?.trim() ?? '';

    const whereClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (search) {
      whereClauses.push(`(t.name ILIKE $${idx} OR t.slug ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }
    if (plan) {
      whereClauses.push(`COALESCE(ab.plan, 'free') = $${idx++}`);
      params.push(plan);
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countRes = await pool.query(
      `SELECT COUNT(DISTINCT t.id)::int as total
       FROM tenants t
       LEFT JOIN admin_billing ab ON ab.tenant_id = t.id::text
       ${whereClause}`,
      params,
    );
    const total = (countRes.rows[0] as any).total ?? 0;

    const result = await pool.query(
      `SELECT
        t.id, t.name, t.slug,
        COUNT(DISTINCT jw.id)::int as teachers,
        COALESCE(ab.plan, 'free') as plan,
        COALESCE(ab.state, 'active') as state,
        COALESCE(ab.seats, 0)::int as seats,
        COALESCE(ab.renews_at::text, '') as renews_at,
        (SELECT jw2.email FROM jwt_users jw2 WHERE jw2.workspace_id = t.id AND jw2.roles @> ARRAY['school_admin'] LIMIT 1) as owner_email
      FROM tenants t
      LEFT JOIN jwt_users jw ON jw.workspace_id = t.id AND jw.roles @> ARRAY['teacher']
      LEFT JOIN admin_billing ab ON ab.tenant_id = t.id::text
      ${whereClause}
      GROUP BY t.id, t.name, t.slug, ab.plan, ab.state, ab.seats, ab.renews_at
      ORDER BY t.name
      LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    );

    await auditLog(request.jwtUser!.userId, 'school.list', 'tenant', 'list', {
      page,
      limit,
      search: Boolean(search),
      filters: { plan },
    });
    return reply.status(200).send({
      data: result.rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        plan: r.plan,
        state: r.state,
        teachers: r.teachers,
        seats: r.seats,
        renewsAt: r.renews_at,
        owner: r.owner_email ?? '—',
      })),
      meta: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
    });
  });

  app.get('/v1/admin/schools/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool)
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'School not found' } });

    const schoolRes = await pool.query(
      `SELECT t.id, t.name, t.slug, ab.plan, ab.state, ab.seats, ab.renews_at::text
       FROM tenants t
       LEFT JOIN admin_billing ab ON ab.tenant_id = t.id::text
       WHERE t.id = $1`,
      [id],
    );
    if (!schoolRes.rows[0])
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'School not found' } });

    const membersRes = await pool.query(
      `SELECT jw.id, jw.email, jw.name, jw.username, jw.roles, jw.created_at::text
       FROM jwt_users jw WHERE jw.workspace_id = $1 ORDER BY jw.created_at`,
      [id],
    );

    await auditLog(request.jwtUser!.userId, 'school.read', 'tenant', id);
    return reply.status(200).send({
      data: {
        school: {
          id: schoolRes.rows[0].id,
          workspaceId: schoolRes.rows[0].id,
          name: schoolRes.rows[0].name,
          slug: schoolRes.rows[0].slug,
          plan: schoolRes.rows[0].plan,
          state: schoolRes.rows[0].state,
          seats: schoolRes.rows[0].seats,
          renewsAt: schoolRes.rows[0].renews_at,
        },
        members: membersRes.rows.map((r: any) => ({
          id: r.id,
          email: r.email,
          name: r.name,
          username: r.username,
          roles: r.roles,
          createdAt: r.created_at,
        })),
        memberCount: membersRes.rows.length,
      },
    });
  });

  app.post('/v1/admin/schools', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const body = request.body as { name?: string; slug?: string } | null;
    if (!body?.name)
      return reply
        .status(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'name required' } });

    const pool = getPool(db);
    if (!pool)
      return reply
        .status(500)
        .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const slug =
      body.slug ||
      body.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    const [created] = await db.insert(tenants).values({ slug, name: body.name }).returning();

    if (!created)
      return reply
        .status(500)
        .send({ error: { code: 'INTERNAL_ERROR', message: 'Gagal membuat sekolah' } });

    const user = request.jwtUser!;
    await auditLog(user.userId, 'school.create', 'tenant', created.id, { name: body.name, slug });
    return reply
      .status(201)
      .send({ data: { id: created.id, name: created.name, slug: created.slug } });
  });

  app.patch('/v1/admin/schools/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string } | null;
    if (!body?.name)
      return reply
        .status(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'name required' } });

    const [updated] = await db
      .update(tenants)
      .set({ name: body.name })
      .where(eq(tenants.id, id))
      .returning();
    if (!updated)
      return reply
        .status(404)
        .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'School not found' } });

    const user = request.jwtUser!;
    await auditLog(user.userId, 'school.update', 'tenant', id, { name: body.name });
    return reply.status(200).send({ data: { id: updated.id, name: updated.name } });
  });

  app.delete(
    '/v1/admin/schools/:id',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const pool = getPool(db);
      if (!pool)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });
      const res = await pool.query('SELECT id, name FROM tenants WHERE id = $1', [id]);
      if (!res.rows[0])
        return reply
          .status(404)
          .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'School not found' } });
      await db.delete(tenants).where(eq(tenants.id, id));
      const user = request.jwtUser!;
      await auditLog(user.userId, 'school.delete', 'tenant', id, {
        name: (res.rows[0] as any).name,
      });
      return reply.status(200).send({ data: { id, deleted: true } });
    },
  );

  // ── Entitlements ─────────────────────────────────────
  app.post(
    '/v1/admin/entitlements/:workspaceId',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const body = request.body as { plan?: string } | null;
      if (!body?.plan || !['free', 'pro'].includes(body.plan))
        return reply
          .status(400)
          .send({ error: { code: 'VALIDATION_FAILED', message: "plan must be 'free' or 'pro'" } });

      const user = request.jwtUser!;
      const result = await service.setEntitlement(user.userId, {
        workspaceId,
        plan: body.plan as 'free' | 'pro',
        actorId: user.userId,
      });
      return reply.status(200).send({ data: result });
    },
  );

  // ── B8-02: Data lifecycle — schedule-delete & purge ───────────────────────
  // PATCH /v1/admin/accounts/:id/schedule-delete
  // Schedule soft-delete + deferred hard-delete setelah retention window (default 30 hari).
  app.patch(
    '/v1/admin/accounts/:id/schedule-delete',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { retentionDays?: number; reason?: string } | null;
      const user = request.jwtUser!;

      const pool = getPool(db);
      if (!pool)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

      // Cek akun ada
      const accountRes = await pool.query(
        'SELECT id, email, roles, tenant_id, workspace_id FROM jwt_users WHERE id = $1',
        [id],
      );
      if (!accountRes.rows[0]) {
        return reply
          .status(404)
          .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });
      }

      // Cek belum ada schedule pending
      const existingRes = await pool.query(
        "SELECT id FROM account_delete_schedule WHERE account_id = $1 AND status = 'pending'",
        [id],
      );
      if (existingRes.rows[0]) {
        return reply
          .status(409)
          .send({
            error: { code: 'CONFLICT', message: 'Delete already scheduled for this account' },
          });
      }

      const retentionDays = Number(body?.retentionDays ?? 30);
      if (retentionDays < 1 || retentionDays > 365) {
        return reply
          .status(400)
          .send({ error: { code: 'VALIDATION_FAILED', message: 'retentionDays must be 1–365' } });
      }
      const reason = body?.reason ?? null;

      const purgeAfter = new Date();
      purgeAfter.setDate(purgeAfter.getDate() + retentionDays);

      // Soft-delete akun
      await pool.query('UPDATE jwt_users SET deleted_at = now() WHERE id = $1', [id]);

      // Buat schedule record
      const schedRes = await pool.query<{ id: string; purge_after: Date }>(
        `INSERT INTO account_delete_schedule
         (account_id, scheduled_by, purge_after, retention_days, reason)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, purge_after`,
        [id, user.userId, purgeAfter.toISOString(), retentionDays, reason],
      );

      await auditLog(user.userId, 'account.delete_scheduled', 'account', id, {
        retentionDays,
        purgeAfter: purgeAfter.toISOString(),
        reason,
      });

      const schedRow = schedRes.rows[0];
      if (!schedRow)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create schedule' } });

      return reply.status(200).send({
        data: {
          accountId: id,
          scheduleId: schedRow.id,
          purgeAfter: schedRow.purge_after,
          retentionDays,
          status: 'pending',
        },
      });
    },
  );

  // DELETE /v1/admin/accounts/:id/purge
  // Hard-delete akun + tulis tombstone (immutable audit trail). Superadmin only.
  app.delete(
    '/v1/admin/accounts/:id/purge',
    { preHandler: [auth, superadmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { reason?: string } | null;
      const user = request.jwtUser!;

      const pool = getPool(db);
      if (!pool)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

      // Cek tombstone sudah ada (idempoten — sudah di-purge sebelumnya)
      const tombRes = await pool.query('SELECT id FROM account_tombstones WHERE original_id = $1', [
        id,
      ]);
      if (tombRes.rows[0]) {
        return reply
          .status(410)
          .send({ error: { code: 'GONE', message: 'Account already purged (tombstone exists)' } });
      }

      // Ambil data akun sebelum dihapus
      const accountRes = await pool.query(
        'SELECT id, email, roles, tenant_id, workspace_id, created_at FROM jwt_users WHERE id = $1',
        [id],
      );
      if (!accountRes.rows[0]) {
        return reply
          .status(404)
          .send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });
      }
      const account = accountRes.rows[0] as {
        id: string;
        email: string;
        roles: string[];
        tenant_id: string | null;
        workspace_id: string | null;
        created_at: Date;
      };

      const reason = body?.reason ?? null;

      // Hash email (PII minimisation — SHA-256)
      const { createHash } = await import('node:crypto');
      const emailHash = createHash('sha256').update(account.email.toLowerCase()).digest('hex');

      const snapshot = {
        roles: account.roles,
        tenantId: account.tenant_id,
        workspaceId: account.workspace_id,
        createdAt: account.created_at,
      };

      // Mark pending schedule sebagai executed (jika ada)
      await pool.query(
        "UPDATE account_delete_schedule SET status = 'executed', executed_at = now() WHERE account_id = $1 AND status = 'pending'",
        [id],
      );

      // Hard-delete dari jwt_users
      await pool.query('DELETE FROM jwt_users WHERE id = $1', [id]);

      // Tulis tombstone (immutable)
      const insertTombstone = await pool.query<{ id: string; purged_at: Date }>(
        `INSERT INTO account_tombstones
         (original_id, email_hash, roles, tenant_id, workspace_id, deleted_by, delete_reason, snapshot, retention_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, purged_at`,
        [
          id,
          emailHash,
          account.roles ?? [],
          account.tenant_id,
          account.workspace_id,
          user.userId,
          reason,
          JSON.stringify(snapshot),
          30,
        ],
      );

      await auditLog(user.userId, 'account.purged', 'account', id, {
        tombstoneId: insertTombstone.rows[0]?.id,
        emailHash,
        reason,
      });

      const tombRow = insertTombstone.rows[0];
      if (!tombRow)
        return reply
          .status(500)
          .send({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create tombstone' } });

      return reply.status(200).send({
        data: {
          purged: true,
          accountId: id,
          tombstoneId: tombRow.id,
          purgedAt: tombRow.purged_at,
          emailHash,
        },
      });
    },
  );
}
