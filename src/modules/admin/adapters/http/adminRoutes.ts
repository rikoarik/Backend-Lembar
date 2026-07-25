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
import { createJwtAuthMiddleware, requireRole } from '../../../../common/middleware/jwtMultiRoleAuth.js';
import {
  adminFlags,
  adminPrompts,
  adminQualityReports,
  adminAudit,
  adminBilling,
} from '../../persistence/adminOpsSchema.js';
import type { AdminService } from '../../application/AdminService.js';
import { tenants } from "../../../../infrastructure/database/schema.js";

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
  const auth = createJwtAuthMiddleware({ secret: jwtSecret });
  const superadmin = requireRole(['superadmin']);

  const auditLog = async (actorId: string, action: string, targetType: string, targetId: string, metadata: Record<string, unknown> = {}) => {
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

  // ── Dashboard KPI ────────────────────────────────────
  app.get('/v1/admin/dashboard', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: { users: 0, schools: 0, jobsActive: 0, qualityOpen: 0, flagsEnabled: 0 } });
    const usersRes = await pool.query<{ count: string }>('SELECT count(*)::text as count FROM jwt_users');
    const tenantsRes = await pool.query<{ count: string }>('SELECT count(*)::text as count FROM tenants');
    const jobsRes = await pool.query<{ count: string }>('SELECT count(*)::text as count FROM spike_jobs WHERE status IN ($1, $2)', ['running', 'queued']);
    const qualityRes = await pool.query<{ count: string }>('SELECT count(*)::text as count FROM admin_quality_reports WHERE status = $1', ['open']);
    const flagsRes = await pool.query<{ count: string }>('SELECT count(*)::text as count FROM admin_flags WHERE enabled = true');
    return reply.status(200).send({
      data: {
        users: Number(usersRes.rows[0]?.count ?? 0),
        schools: Number(tenantsRes.rows[0]?.count ?? 0),
        jobsActive: Number(jobsRes.rows[0]?.count ?? 0),
        qualityOpen: Number(qualityRes.rows[0]?.count ?? 0),
        flagsEnabled: Number(flagsRes.rows[0]?.count ?? 0),
      },
    });
  });

  app.get('/v1/admin/dashboard/trends', { preHandler: [auth, superadmin] }, async (request, reply) => {
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

    return reply.status(200).send({
      data: {
        jobs: jobsTrend.rows.map((r) => ({ day: r.day, count: Number(r.count) })),
        quality: qualityTrend.rows.map((r) => ({ day: r.day, count: Number(r.count) })),
      },
    });
  });

  // ── Accounts ──────────────────────────────────────────
  app.get('/v1/admin/accounts', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const q = request.query as Record<string, string>;
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: [], meta: { total: 0, page: 1, limit: 50, pages: 1 } });

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
      whereClauses.push(`(jw.email ILIKE $${idx} OR jw.name ILIKE $${idx} OR jw.username ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }
    if (role) {
      whereClauses.push(`$${idx} = ANY(jw.roles)`);
      params.push(role);
      idx++;
    }
    if (status === 'ditangguhkan') {
      whereClauses.push(`ab.state = 'blocked'`);
    } else if (status === 'baru') {
      whereClauses.push(`jw.created_at > now() - interval '7 days' AND (ab.state IS NULL OR ab.state != 'blocked')`);
    } else if (status === 'aktif') {
      whereClauses.push(`jw.created_at <= now() - interval '7 days' AND (ab.state IS NULL OR ab.state != 'blocked')`);
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
         CASE WHEN ab.state = 'blocked' THEN 'ditangguhkan'
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

    return reply.status(200).send({
      data,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  });

  app.get('/v1/admin/accounts/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });

    const res = await pool.query(`
      SELECT
        jw.id, jw.email, jw.name, jw.username, jw.phone, jw.roles,
        jw.workspace_id, jw.created_at, jw.updated_at, jw.last_login_at,
        t.name as school_name, t.slug as school_slug,
        ab.state as billing_state, ab.plan as billing_plan,
        ab.seats as billing_seats, ab.renews_at as billing_renews_at,
        CASE WHEN ab.state = 'blocked' THEN 'ditangguhkan'
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
    `, [id]);

    if (!res.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });
    const r = res.rows[0] as any;

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

  app.patch('/v1/admin/accounts/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; phone?: string } | null;
    if (!body?.name && !body?.phone)
      return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'name or phone required' } });

    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const setClauses: string[] = ['updated_at = now()'];
    const params: unknown[] = [];
    let idx = 1;
    if (body.name) { setClauses.push(`name = $${idx++}`); params.push(body.name); }
    if (body.phone !== undefined) { setClauses.push(`phone = $${idx++}`); params.push(body.phone || null); }
    params.push(id);

    const res = await pool.query(
      `UPDATE jwt_users SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING id, email, name, phone, updated_at`,
      params,
    );
    if (!res.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });

    const actor = request.jwtUser!;
    await auditLog(actor.userId, 'account.update', 'user', id, { name: body.name, phone: body.phone });
    return reply.status(200).send({ data: res.rows[0] });
  });

  app.patch('/v1/admin/accounts/:id/roles', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { roles?: string[] } | null;
    if (!body?.roles || !Array.isArray(body.roles))
      return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'roles array required' } });

    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    await pool.query('UPDATE jwt_users SET roles = $1::text[] WHERE id = $2', [body.roles, id]);
    const user = request.jwtUser!;
    await auditLog(user.userId, 'account.roles', 'user', id, { roles: body.roles });
    return reply.status(200).send({ data: { id, roles: body.roles } });
  });

  app.post('/v1/admin/accounts/:id/suspend', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const res = await pool.query('SELECT workspace_id FROM jwt_users WHERE id = $1', [id]);
    if (!res.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });

    const workspaceId = (res.rows[0] as any).workspace_id;
    if (workspaceId) {
      await pool.query(`INSERT INTO admin_billing (tenant_id, school_name, state) VALUES ($1, 'Suspended', 'blocked')
        ON CONFLICT (tenant_id) DO UPDATE SET state = 'blocked'`, [workspaceId]);
    }
    const user = request.jwtUser!;
    await auditLog(user.userId, 'account.suspend', 'user', id, { workspaceId });
    return reply.status(200).send({ data: { id, suspended: true } });
  });

  // ── Bulk operations ──────────────────────────────────────
  app.post('/v1/admin/accounts/bulk/suspend', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const body = request.body as { ids?: string[] } | null;
    if (!body?.ids || !Array.isArray(body.ids) || body.ids.length === 0)
      return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'ids array required' } });

    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const results: { id: string; success: boolean; error?: string }[] = [];
    const actor = request.jwtUser!;

    for (const id of body.ids) {
      try {
        const res = await pool.query('SELECT workspace_id FROM jwt_users WHERE id = $1', [id]);
        if (!res.rows[0]) { results.push({ id, success: false, error: 'Not found' }); continue; }
        const workspaceId = (res.rows[0] as any).workspace_id;
        if (workspaceId) {
          await pool.query(`INSERT INTO admin_billing (tenant_id, school_name, state) VALUES ($1, 'Suspended', 'blocked')
            ON CONFLICT (tenant_id) DO UPDATE SET state = 'blocked'`, [workspaceId]);
        }
        await auditLog(actor.userId, 'account.suspend', 'user', id, { workspaceId, bulk: true });
        results.push({ id, success: true });
      } catch { results.push({ id, success: false, error: 'Internal error' }); }
    }

    const succeeded = results.filter((r) => r.success).length;
    return reply.status(200).send({ data: { results, succeeded, failed: results.length - succeeded } });
  });

  app.post('/v1/admin/accounts/bulk/unsuspend', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const body = request.body as { ids?: string[] } | null;
    if (!body?.ids || !Array.isArray(body.ids) || body.ids.length === 0)
      return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'ids array required' } });

    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const results: { id: string; success: boolean; error?: string }[] = [];
    const actor = request.jwtUser!;

    for (const id of body.ids) {
      try {
        const res = await pool.query('SELECT workspace_id FROM jwt_users WHERE id = $1', [id]);
        if (!res.rows[0]) { results.push({ id, success: false, error: 'Not found' }); continue; }
        const workspaceId = (res.rows[0] as any).workspace_id;
        if (workspaceId) {
          await pool.query(`UPDATE admin_billing SET state = 'active' WHERE tenant_id = $1`, [workspaceId]);
        }
        await auditLog(actor.userId, 'account.unsuspend', 'user', id, { workspaceId, bulk: true });
        results.push({ id, success: true });
      } catch { results.push({ id, success: false, error: 'Internal error' }); }
    }

    const succeeded = results.filter((r) => r.success).length;
    return reply.status(200).send({ data: { results, succeeded, failed: results.length - succeeded } });
  });

  app.post('/v1/admin/accounts/bulk/delete', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const body = request.body as { ids?: string[] } | null;
    if (!body?.ids || !Array.isArray(body.ids) || body.ids.length === 0)
      return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'ids array required' } });

    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const actor = request.jwtUser!;
    const results: { id: string; success: boolean; error?: string }[] = [];

    for (const id of body.ids) {
      try {
        if (actor.userId === id) { results.push({ id, success: false, error: 'Tidak bisa hapus akun sendiri' }); continue; }
        const res = await pool.query('SELECT email, name, roles FROM jwt_users WHERE id = $1', [id]);
        if (!res.rows[0]) { results.push({ id, success: false, error: 'Not found' }); continue; }
        const target = res.rows[0] as any;
        if (target.roles?.includes('superadmin')) { results.push({ id, success: false, error: 'Tidak bisa hapus superadmin' }); continue; }
        await pool.query('DELETE FROM jwt_users WHERE id = $1', [id]);
        await auditLog(actor.userId, 'account.delete', 'user', id, { email: target.email, bulk: true });
        results.push({ id, success: true });
      } catch { results.push({ id, success: false, error: 'Internal error' }); }
    }

    const succeeded = results.filter((r) => r.success).length;
    return reply.status(200).send({ data: { results, succeeded, failed: results.length - succeeded } });
  });

  app.post('/v1/admin/accounts/:id/unsuspend', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const res = await pool.query('SELECT workspace_id FROM jwt_users WHERE id = $1', [id]);
    if (!res.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });

    const workspaceId = (res.rows[0] as any).workspace_id;
    if (workspaceId) {
      await pool.query(`UPDATE admin_billing SET state = 'active' WHERE tenant_id = $1`, [workspaceId]);
    }
    const user = request.jwtUser!;
    await auditLog(user.userId, 'account.unsuspend', 'user', id, { workspaceId });
    return reply.status(200).send({ data: { id, suspended: false } });
  });

  app.post('/v1/admin/accounts/:id/impersonate', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    // Fetch target user
    const res = await pool.query(
      `SELECT id, email, name, roles, workspace_id FROM jwt_users WHERE id = $1`,
      [id],
    );
    if (!res.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });

    const target = res.rows[0] as any;
    const actingUser = request.jwtUser!;

    // Sign a short-lived impersonation token (1 hour) using jsonwebtoken
    const { sign } = await import('jsonwebtoken');
    const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-in-production';
    const token = sign(
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

    return reply.status(200).send({
      data: {
        token,
        targetId: target.id,
        targetEmail: target.email,
        targetName: target.name,
        expiresIn: 3600,
        note: 'Token berlaku 1 jam. Gunakan header Authorization: Bearer <token> untuk akses.',
      },
    });
  });

  app.post('/v1/admin/accounts/:id/reset-password', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const res = await pool.query('SELECT email FROM jwt_users WHERE id = $1', [id]);
    if (!res.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });

    const user = request.jwtUser!;
    await auditLog(user.userId, 'account.reset_password', 'user', id, { email: (res.rows[0] as any).email });
    return reply.status(200).send({ data: { id, resetSent: true } });
  });

  app.delete('/v1/admin/accounts/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    // Cegah hapus diri sendiri
    const actingUser = request.jwtUser!;
    if (actingUser.userId === id) {
      return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'Tidak bisa menghapus akun sendiri' } });
    }

    const res = await pool.query('SELECT email, name, roles FROM jwt_users WHERE id = $1', [id]);
    if (!res.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Account not found' } });

    const target = res.rows[0] as any;

    // Cegah hapus superadmin lain
    if (target.roles?.includes('superadmin')) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Tidak bisa menghapus akun superadmin' } });
    }

    await pool.query('DELETE FROM jwt_users WHERE id = $1', [id]);
    await auditLog(actingUser.userId, 'account.delete', 'user', id, {
      email: target.email,
      name: target.name,
    });
    return reply.status(200).send({ data: { id, deleted: true, email: target.email } });
  });

  app.post('/v1/admin/accounts/invite', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const body = request.body as { email: string; name?: string; role?: string } | null;
    if (!body?.email) return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'email required' } });
    if (!body) return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'body required' } });
    const inputEmail = String(body.email || '');
    const inputName = body.name || inputEmail;
    const inputRole = body.role || 'subscriber';

    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const existing = await pool.query('SELECT id FROM jwt_users WHERE email = $1', [inputEmail]);
    if (existing.rows[0]) return reply.status(409).send({ error: { code: 'CONFLICT', message: 'Email sudah terdaftar' } });

    const parts = inputEmail.split('@');
    const slug = (parts[0] || 'user').replace(/[^a-z0-9]/g, '-');
    const tenantRes = await pool.query(`INSERT INTO tenants (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING RETURNING id`, ['invited-' + slug, inputName + ' Workspace']);
    const tenantId = tenantRes.rows[0]?.id ?? null;

    await pool.query(
      `INSERT INTO jwt_users (email, name, username, password_hash, roles, workspace_id) VALUES ($1, $2, $3, $4, $5::text[], $6)`,
      [inputEmail, inputName, slug, '$2b$10$placeholder', [inputRole], tenantId],
    );
    const user = request.jwtUser!;
    await auditLog(user.userId, 'account.invite', 'user', inputEmail, { role: inputRole });
    return reply.status(201).send({ data: { email: inputEmail, invited: true } });
  });


  // ── Jobs ──────────────────────────────────────────────
  app.get('/v1/admin/jobs', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const q = request.query as Record<string, string>;
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: [], meta: { total: 0, page: 1, limit: 50, pages: 1 } });

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

    if (status) { whereClauses.push(`sj.status = $${idx++}`); params.push(status); }
    if (tenant) { whereClauses.push(`sj.workspace_id = $${idx++}`); params.push(tenant); }
    if (type) { whereClauses.push(`sj.type = $${idx++}`); params.push(type); }
    if (search) { whereClauses.push(`(sj.id ILIKE $${idx} OR sj.type ILIKE $${idx})`); params.push(`%${search}%`); idx++; }

    const where = whereClauses.join(' AND ');

    const countRes = await pool.query(`SELECT COUNT(*) as total FROM spike_jobs sj WHERE ${where}`, params);
    const total = parseInt((countRes.rows[0] as any).total, 10);

    const dataRes = await pool.query(
      `SELECT sj.id, sj.type, sj.status, sj.workspace_id, sj.attempt, sj.created_at, sj.updated_at,
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
      type: r.type,
      status: r.status,
      tenant: r.tenant_name ?? r.workspace_id ?? '—',
      workspaceId: r.workspace_id,
      attempt: r.attempt ?? 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return reply.status(200).send({ data, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
  });

  app.get('/v1/admin/jobs/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Job not found' } });
    const res = await pool.query('SELECT * FROM spike_jobs WHERE id = $1', [id]);
    if (!res.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Job not found' } });
    return reply.status(200).send({ data: res.rows[0] });
  });

  app.post('/v1/admin/jobs/:id/retry', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });
    const res = await pool.query('SELECT id, status FROM spike_jobs WHERE id = $1', [id]);
    if (!res.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Job not found' } });
    if ((res.rows[0] as any).status !== 'failed') return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'Only failed jobs can be retried' } });
    await pool.query('UPDATE spike_jobs SET status = $1, attempt = attempt + 1 WHERE id = $2', ['queued', id]);
    const user = request.jwtUser!;
    await auditLog(user.userId, 'job.retry', 'job', id, {});
    return reply.status(200).send({ data: { id, retried: true } });
  });

  // ── Quality Reports ──────────────────────────────────
  app.get('/v1/admin/quality-reports', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const q = request.query as Record<string, string>;
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: [], meta: { total: 0, page: 1, limit: 50, pages: 1 } });

    const page = Math.max(1, parseInt(q['page'] ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q['limit'] ?? '50', 10)));
    const offset = (page - 1) * limit;
    const status = q['status']?.trim() ?? '';
    const search = q['q']?.trim() ?? '';

    const whereClauses: string[] = ['1=1'];
    const params: unknown[] = [];
    let idx = 1;

    if (status) { whereClauses.push(`qr.status = $${idx++}`); params.push(status); }
    if (search) { whereClauses.push(`(qr.reason ILIKE $${idx} OR qr.reporter ILIKE $${idx})`); params.push(`%${search}%`); idx++; }

    const where = whereClauses.join(' AND ');

    const countRes = await pool.query(`SELECT COUNT(*) as total FROM admin_quality_reports qr WHERE ${where}`, params);
    const total = parseInt((countRes.rows[0] as any).total, 10);

    const dataRes = await pool.query(
      `SELECT qr.id, qr.reason, qr.status, qr.reporter, qr.notes, qr.workspace_id, qr.created_at
       FROM admin_quality_reports qr
       WHERE ${where}
       ORDER BY qr.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    );

    return reply.status(200).send({
      data: dataRes.rows.map((r: any) => ({
        id: r.id, reason: r.reason, status: r.status, reporter: r.reporter,
        notes: r.notes ?? '', workspaceId: r.workspace_id,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  });

  app.patch('/v1/admin/quality-reports/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string; notes?: string } | null;
    // allow notes-only update (no status required when only notes provided)
    if (!body?.status && body?.notes === undefined) return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'status or notes required' } });

    await db.update(adminQualityReports)
      .set({ status: body.status, notes: body.notes ?? '', updatedAt: new Date() })
      .where(eq(adminQualityReports.id, id));

    const user = request.jwtUser!;
    await auditLog(user.userId, 'quality.update', 'report', id, { status: body.status });
    return reply.status(200).send({ data: { id, status: body.status } });
  });

  app.get('/v1/admin/quality-reports/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Report not found' } });
    const res = await pool.query('SELECT * FROM admin_quality_reports WHERE id = $1', [id]);
    if (!res.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Report not found' } });
    const r = res.rows[0] as any;
    return reply.status(200).send({
      data: { id: r.id, reason: r.reason, status: r.status, reporter: r.reporter, notes: r.notes,
        workspaceId: r.workspace_id, createdAt: r.created_at },
    });
  });

  // ── Flags ─────────────────────────────────────────────
  app.get('/v1/admin/flags', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: [] });
    const result = await pool.query(
      `SELECT id, key, description, enabled::text, scope, created_at, updated_at FROM admin_flags ORDER BY created_at DESC`,
    );
    return reply.status(200).send({ data: result.rows.map((r: any) => ({ ...r, enabled: r.enabled === 'true' })) });
  });

  app.get('/v1/admin/flags/:key', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const pool = getPool(db);
    if (!pool) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Flag tidak ditemukan' } });
    const res = await pool.query(
      `SELECT id, key, description, enabled::text, scope, created_at, updated_at FROM admin_flags WHERE key = $1`,
      [key],
    );
    if (!res.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Flag tidak ditemukan' } });
    const r = res.rows[0] as any;
    return reply.status(200).send({ data: { ...r, enabled: r.enabled === 'true' } });
  });

  app.delete('/v1/admin/flags/:key', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const user = request.jwtUser!;
    const [flag] = await db.select().from(adminFlags).where(eq(adminFlags.key, key)).limit(1);
    if (!flag) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Flag tidak ditemukan' } });
    await db.delete(adminFlags).where(eq(adminFlags.key, key));
    await auditLog(user.userId, 'flag.delete', 'flag', key, { key });
    return reply.status(200).send({ data: { key, deleted: true } });
  });

  app.patch('/v1/admin/flags/:key/toggle', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const user = request.jwtUser!;
    const [flag] = await db.select().from(adminFlags).where(eq(adminFlags.key, key)).limit(1);
    if (!flag) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Flag tidak ditemukan' } });

    const newEnabled = flag.enabled === 'true' ? 'false' : 'true';
    await db.update(adminFlags).set({ enabled: newEnabled, updatedAt: new Date() }).where(eq(adminFlags.id, flag.id));
    await auditLog(user.userId, 'flag.toggle', 'flag', key, { enabled: newEnabled });

    return reply.status(200).send({ data: { key, enabled: newEnabled === 'true' } });
  });

  app.post('/v1/admin/flags', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const body = request.body as { key?: string; description?: string; scope?: string } | null;
    if (!body?.key) return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'key required' } });
    const user = request.jwtUser!;
    const [created] = await db.insert(adminFlags).values({
      key: body.key, description: body.description ?? '', scope: body.scope ?? 'global',
    }).returning();
    await auditLog(user.userId, 'flag.create', 'flag', body.key, { scope: body.scope ?? 'global' });
    return reply.status(201).send({ data: { key: body.key, enabled: false, scope: body.scope ?? 'global' } });
  });

  app.patch('/v1/admin/flags/:key', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const body = request.body as { description?: string; scope?: string } | null;
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body?.description !== undefined) updates.description = body.description;
    if (body?.scope) updates.scope = body.scope;
    const [updated] = await db.update(adminFlags).set(updates).where(eq(adminFlags.key, key)).returning();
    if (!updated) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Flag not found' } });
    const user = request.jwtUser!;
    await auditLog(user.userId, 'flag.update', 'flag', key, body ?? {});
    return reply.status(200).send({ data: { key, ...body } });
  });


  // ── Audit Trail ──────────────────────────────────────
  app.get('/v1/admin/audit', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const q = request.query as Record<string, string>;
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: [], meta: { total: 0, page: 1, limit: 50, pages: 1 } });

    const page = Math.max(1, parseInt(q['page'] ?? '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(q['limit'] ?? '50', 10)));
    const offset = (page - 1) * limit;

    const whereClauses: string[] = ['1=1'];
    const params: any[] = [];
    let paramIdx = 1;
    if (q['action']) { whereClauses.push(`action = $${paramIdx++}`); params.push(q['action']); }
    if (q['actor']) { whereClauses.push(`(actor_email = $${paramIdx} OR actor_id = $${paramIdx})`); params.push(q['actor']); paramIdx++; }
    if (q['from']) { whereClauses.push(`created_at >= $${paramIdx++}`); params.push(q['from']); }
    if (q['to']) { whereClauses.push(`created_at <= $${paramIdx++}`); params.push(q['to']); }

    const whereClause = 'WHERE ' + whereClauses.join(' AND ');

    const countRes = await pool.query(`SELECT COUNT(*) as total FROM admin_audit ${whereClause}`, params);
    const total = parseInt((countRes.rows[0] as any).total, 10);

    const result = await pool.query(
      `SELECT id, actor_id, actor_email, action, target_type, target_id, metadata, created_at
       FROM admin_audit ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset],
    );
    return reply.status(200).send({
      data: result.rows.map((r: any) => ({
        id: r.id,
        at: new Date(r.created_at).toLocaleString('id-ID', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/\//g, '-'),
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
    if (!pool) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Audit entry not found' } });
    const res = await pool.query(
      `SELECT aa.id, aa.actor_id, aa.actor_email, aa.action, aa.target_type, aa.target_id, aa.metadata, aa.created_at,
              jw.email as actor_email_lookup, jw.name as actor_name
       FROM admin_audit aa
       LEFT JOIN jwt_users jw ON jw.id = aa.actor_id
       WHERE aa.id = $1`,
      [id],
    );
    if (!res.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Audit entry not found' } });
    const r = res.rows[0] as any;
    return reply.status(200).send({
      data: {
        id: r.id,
        actor: r.actor_email || r.actor_email_lookup || r.actor_id,
        actorName: r.actor_name ?? '',
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
    if (!pool) return reply.status(200).send({ data: [], meta: { total: 0, page: 1, limit: 50, pages: 1 } });

    const page = Math.max(1, parseInt(q['page'] ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q['limit'] ?? '50', 10)));
    const offset = (page - 1) * limit;
    const state = q['state']?.trim() ?? '';
    const search = q['q']?.trim() ?? '';

    const whereClauses: string[] = ['1=1'];
    const params: unknown[] = [];
    let idx = 1;

    if (state) { whereClauses.push(`state = $${idx++}`); params.push(state); }
    if (search) { whereClauses.push(`school_name ILIKE $${idx++}`); params.push(`%${search}%`); }

    const where = whereClauses.join(' AND ');

    const countRes = await pool.query(`SELECT COUNT(*) as total FROM admin_billing WHERE ${where}`, params);
    const total = parseInt((countRes.rows[0] as any).total, 10);

    const result = await pool.query(
      `SELECT id, tenant_id, school_name, state, seats::text, plan, renews_at, created_at, updated_at
       FROM admin_billing WHERE ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    );
    return reply.status(200).send({
      data: result.rows.map((r: any) => ({
        id: r.id, school: r.school_name, state: r.state, seats: r.seats, plan: r.plan,
        renewsAt: r.renews_at ? new Date(r.renews_at).toISOString().slice(0, 10) : '',
        tenantId: r.tenant_id,
      })),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  });

  app.post('/v1/admin/billing', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const body = request.body as { tenantId?: string; schoolName?: string; plan?: string; seats?: number; state?: string; renewsAt?: string } | null;
    if (!body?.tenantId || !body?.schoolName) return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'tenantId and schoolName required' } });
    const user = request.jwtUser!;
    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const existing = await pool.query('SELECT id FROM admin_billing WHERE tenant_id = $1', [body.tenantId]);
    if (existing.rows[0]) return reply.status(409).send({ error: { code: 'CONFLICT', message: 'Billing record already exists for this tenant' } });

    const res = await pool.query(
      `INSERT INTO admin_billing (tenant_id, school_name, plan, seats, state, renews_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [body.tenantId, body.schoolName, body.plan ?? 'free', body.seats ?? 0, body.state ?? 'active', body.renewsAt ?? null],
    );
    await auditLog(user.userId, 'billing.create', 'billing', (res.rows[0] as any).id, { tenantId: body.tenantId, plan: body.plan });
    return reply.status(201).send({ data: { id: (res.rows[0] as any).id, tenantId: body.tenantId, schoolName: body.schoolName } });
  });

  app.patch('/v1/admin/billing/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { state?: string; plan?: string; seats?: number } | null;
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body?.state) updates.state = body.state;
    if (body?.plan) updates.plan = body.plan;
    if (body?.seats !== undefined) updates.seats = body.seats;

    const [updated] = await db.update(adminBilling).set(updates).where(eq(adminBilling.id, id)).returning();
    if (!updated) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Billing tidak ditemukan' } });

    const user = request.jwtUser!;
    await auditLog(user.userId, 'billing.update', 'billing', id, body ?? {});
    return reply.status(200).send({ data: { id, ...body } });
  });

  app.get('/v1/admin/billing/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Billing not found' } });
    const res = await pool.query('SELECT * FROM admin_billing WHERE id = $1', [id]);
    if (!res.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Billing not found' } });
    const r = res.rows[0] as any;
    return reply.status(200).send({
      data: { id: r.id, school: r.school_name, state: r.state, seats: r.seats, plan: r.plan,
        renewsAt: r.renews_at ? new Date(r.renews_at).toISOString().slice(0, 10) : '',
        tenantId: r.tenant_id, createdAt: r.created_at },
    });
  });

  // ── Schools / Tenants ──────────────────────────────
  app.get('/v1/admin/schools', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: [] });

    const result = await pool.query(`
      SELECT
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
      GROUP BY t.id, t.name, t.slug, ab.plan, ab.state, ab.seats, ab.renews_at
      ORDER BY t.name
    `);

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
    });
  });

  app.get('/v1/admin/schools/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'School not found' } });

    const schoolRes = await pool.query(
      `SELECT t.id, t.name, t.slug, ab.plan, ab.state, ab.seats, ab.renews_at::text
       FROM tenants t
       LEFT JOIN admin_billing ab ON ab.tenant_id = t.id::text
       WHERE t.id = $1`,
      [id],
    );
    if (!schoolRes.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'School not found' } });

    const membersRes = await pool.query(
      `SELECT jw.id, jw.email, jw.name, jw.username, jw.roles, jw.created_at::text
       FROM jwt_users jw WHERE jw.workspace_id = $1 ORDER BY jw.created_at`,
      [id],
    );

    return reply.status(200).send({
      data: {
        school: {
          id: schoolRes.rows[0].id,
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
    if (!body?.name) return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'name required' } });

    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const slug = body.slug || body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const [created] = await db.insert(tenants).values({ slug, name: body.name }).returning();

    if (!created) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Gagal membuat sekolah' } });

    const user = request.jwtUser!;
    await auditLog(user.userId, 'school.create', 'tenant', created.id, { name: body.name, slug });
    return reply.status(201).send({ data: { id: created.id, name: created.name, slug: created.slug } });
  });

  app.patch('/v1/admin/schools/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string } | null;
    if (!body?.name) return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'name required' } });

    const [updated] = await db.update(tenants).set({ name: body.name }).where(eq(tenants.id, id)).returning();
    if (!updated) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'School not found' } });

    const user = request.jwtUser!;
    await auditLog(user.userId, 'school.update', 'tenant', id, { name: body.name });
    return reply.status(200).send({ data: { id: updated.id, name: updated.name } });
  });

  app.delete('/v1/admin/schools/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });
    const res = await pool.query('SELECT id, name FROM tenants WHERE id = $1', [id]);
    if (!res.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'School not found' } });
    await db.delete(tenants).where(eq(tenants.id, id));
    const user = request.jwtUser!;
    await auditLog(user.userId, 'school.delete', 'tenant', id, { name: (res.rows[0] as any).name });
    return reply.status(200).send({ data: { id, deleted: true } });
  });

  // ── Entitlements ─────────────────────────────────────
  app.post('/v1/admin/entitlements/:workspaceId', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const body = request.body as { plan?: string } | null;
    if (!body?.plan || !['free', 'pro'].includes(body.plan))
      return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: "plan must be 'free' or 'pro'" } });

    const user = request.jwtUser!;
    const result = await service.setEntitlement(user.userId, { workspaceId, plan: body.plan as 'free' | 'pro', actorId: user.userId });
    return reply.status(200).send({ data: result });
  });
}
