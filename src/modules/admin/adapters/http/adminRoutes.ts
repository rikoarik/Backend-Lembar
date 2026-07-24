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

  // ── Accounts ──────────────────────────────────────────
  app.get('/v1/admin/accounts', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const accounts = await service.listAccounts('superadmin');
    return reply.status(200).send({ data: accounts });
  });

  // ── Jobs ──────────────────────────────────────────────
  app.get('/v1/admin/jobs', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const q = request.query as Record<string, string>;
    const limit = q['limit'] ? parseInt(q['limit'], 10) : undefined;
    const jobs = await service.listJobs('superadmin', limit);
    return reply.status(200).send({ data: jobs });
  });

  // ── Quality Reports ──────────────────────────────────
  app.get('/v1/admin/quality-reports', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const q = request.query as Record<string, string>;
    const limit = q['limit'] ? parseInt(q['limit'], 10) : undefined;
    const reports = await service.listQualityReports('superadmin', limit);
    return reply.status(200).send({ data: reports });
  });

  app.patch('/v1/admin/quality-reports/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string; notes?: string } | null;
    if (!body?.status) return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'status required' } });

    await db.update(adminQualityReports)
      .set({ status: body.status, notes: body.notes ?? '', updatedAt: new Date() })
      .where(eq(adminQualityReports.id, id));

    const user = request.jwtUser!;
    await auditLog(user.userId, 'quality.update', 'report', id, { status: body.status });
    return reply.status(200).send({ data: { id, status: body.status } });
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

  // ── Prompts ──────────────────────────────────────────
  app.get('/v1/admin/prompts', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: [] });
    const result = await pool.query(
      `SELECT id, name, slug, description, version, status, created_by, created_at, updated_at FROM admin_prompts ORDER BY created_at DESC`,
    );
    return reply.status(200).send({ data: result.rows.map((r: any) => ({ id: r.id, name: r.name, owner: r.created_by, status: r.status })) });
  });

  app.post('/v1/admin/prompts', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const body = request.body as { name: string; slug?: string; description?: string; prompt_text?: string; version?: string } | null;
    if (!body?.name) return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'name required' } });

    const slug = body.slug || body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const user = request.jwtUser!;
    const [created] = await db.insert(adminPrompts).values({
      name: body.name,
      slug,
      description: body.description ?? '',
      promptText: body.prompt_text ?? '',
      version: body.version ?? 'v1',
      createdBy: user.userId,
    }).returning();

    await auditLog(user.userId, 'prompt.create', 'prompt', created?.id ?? 'unknown');
    return reply.status(201).send({ data: created ?? { slug, name: body.name } });
  });

  app.patch('/v1/admin/prompts/:slug/status', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const body = request.body as { status?: string } | null;
    if (!body?.status || !['active', 'draft'].includes(body.status))
      return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'status must be active or draft' } });

    const [updated] = await db.update(adminPrompts).set({ status: body.status, updatedAt: new Date() }).where(eq(adminPrompts.slug, slug)).returning();
    if (!updated) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Prompt tidak ditemukan' } });

    const user = request.jwtUser!;
    await auditLog(user.userId, 'prompt.status', 'prompt', updated.id, { status: body.status });
    return reply.status(200).send({ data: { slug, status: body.status } });
  });

  // ── Audit Trail ──────────────────────────────────────
  app.get('/v1/admin/audit', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const q = request.query as Record<string, string>;
    const limit = q['limit'] ? parseInt(q['limit'], 10) : 50;
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: [] });

    const result = await pool.query(
      `SELECT id, actor_id, actor_email, action, target_type, target_id, metadata, created_at
       FROM admin_audit ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return reply.status(200).send({ data: result.rows.map((r: any) => ({
        id: r.id,
        at: new Date(r.created_at).toLocaleString('id-ID', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/\//g, '-'),
        actor: r.actor_email || r.actor_id,
        action: r.action,
        target: r.target_id,
      })) });
  });

  // ── Billing ──────────────────────────────────────────
  app.get('/v1/admin/billing', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: [] });
    const result = await pool.query(
      `SELECT id, tenant_id, school_name, state, seats::text, plan, renews_at, created_at, updated_at
       FROM admin_billing ORDER BY created_at DESC`,
    );
    return reply.status(200).send({ data: result.rows.map((r: any) => ({
      id: r.id,
      school: r.school_name,
      state: r.state,
      seats: r.seats,
      plan: r.plan,
      renewsAt: r.renews_at ? new Date(r.renews_at).toISOString().slice(0, 10) : '',
    })) });
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
