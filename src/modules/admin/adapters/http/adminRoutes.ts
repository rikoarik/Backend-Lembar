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
    return reply.status(200).send({ data: result.rows });
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
    return reply.status(200).send({ data: result.rows });
  });

  // ── Billing ──────────────────────────────────────────
  app.get('/v1/admin/billing', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: [] });
    const result = await pool.query(
      `SELECT id, tenant_id, school_name, state, seats::text, plan, renews_at, created_at, updated_at
       FROM admin_billing ORDER BY created_at DESC`,
    );
    return reply.status(200).send({ data: result.rows });
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
