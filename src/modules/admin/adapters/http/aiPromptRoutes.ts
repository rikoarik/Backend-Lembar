/**
 * AI Prompt Management routes — superadmin only.
 *
 * Full lifecycle: list/detail prompts, version management, eval cases,
 * performance metrics from ai_jobs_audit.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool, type Database } from '../../../../infrastructure/database/db.js';
import { createJwtAuthMiddleware, requireRole } from '../../../../common/middleware/jwtMultiRoleAuth.js';
import { adminPrompts } from '../../persistence/adminOpsSchema.js';

export interface RegisterAiPromptRoutesOptions {
  db: Database;
  jwtSecret: string;
}

export async function registerAiPromptRoutes(
  app: FastifyInstance,
  options: RegisterAiPromptRoutesOptions,
): Promise<void> {
  const { db, jwtSecret } = options;
  const auth = createJwtAuthMiddleware({ secret: jwtSecret });
  const superadmin = requireRole(['superadmin']);

  const auditLog = async (actorId: string, action: string, targetId: string, metadata: Record<string, unknown> = {}) => {
    const pool = getPool(db);
    if (!pool) return;
    try {
      await pool.query(
        `INSERT INTO admin_audit (actor_id, actor_email, action, target_type, target_id, metadata) VALUES ($1, '', $2, 'prompt', $3, $4)`,
        [actorId, action, targetId, JSON.stringify(metadata)],
      );
    } catch { /* best-effort */ }
  };

  // ── List prompts with performance metrics ──────────
  app.get('/v1/admin/prompts', { preHandler: [auth, superadmin] }, async (_request, reply) => {
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: [] });

    const result = await pool.query(`
      SELECT
        p.id, p.name, p.slug, p.description, p.status, p.version,
        p.context_window, p.active_version, p.created_by,
        p.avg_latency_ms, p.avg_cost_usd, p.success_rate, p.total_runs, p.last_run_at,
        p.created_at, p.updated_at,
        (SELECT COUNT(*)::int FROM ai_prompt_versions pv WHERE pv.prompt_id = p.id) as version_count,
        (SELECT COUNT(*)::int FROM ai_prompt_eval_cases pe WHERE pe.prompt_id = p.id) as eval_count
      FROM admin_prompts p ORDER BY p.created_at DESC
    `);

    return reply.status(200).send({
      data: result.rows.map((r: any) => ({
        id: r.id, name: r.name, slug: r.slug, description: r.description, status: r.status,
        version: Number(r.version), activeVersion: Number(r.active_version),
        contextWindow: r.context_window, owner: r.created_by,
        versionCount: r.version_count, evalCount: r.eval_count,
        metrics: {
          avgLatencyMs: r.avg_latency_ms, avgCostUsd: Number(r.avg_cost_usd ?? 0),
          successRate: Number(r.success_rate ?? 0), totalRuns: r.total_runs,
          lastRunAt: r.last_run_at,
        },
        createdAt: r.created_at, updatedAt: r.updated_at,
      })),
    });
  });

  // ── Prompt detail ──────────────────────────────────
  app.get('/v1/admin/prompts/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Prompt not found' } });

    const promptRes = await pool.query('SELECT * FROM admin_prompts WHERE id = $1', [id]);
    if (!promptRes.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Prompt not found' } });

    const versionsRes = await pool.query('SELECT * FROM ai_prompt_versions WHERE prompt_id = $1 ORDER BY version DESC', [id]);
    const evalRes = await pool.query('SELECT * FROM ai_prompt_eval_cases WHERE prompt_id = $1 ORDER BY created_at', [id]);

    const r = promptRes.rows[0] as any;
    return reply.status(200).send({
      data: {
        id: r.id, name: r.name, slug: r.slug, description: r.description,
        descriptionLong: r.description_long, status: r.status, version: Number(r.version),
        activeVersion: Number(r.active_version), contextWindow: r.context_window,
        schemaId: r.schema_id, owner: r.created_by,
        metrics: {
          avgLatencyMs: r.avg_latency_ms, avgCostUsd: Number(r.avg_cost_usd ?? 0),
          successRate: Number(r.success_rate ?? 0), totalRuns: r.total_runs,
          lastRunAt: r.last_run_at,
        },
        versions: versionsRes.rows.map((v: any) => ({
          id: v.id, version: v.version, promptText: v.prompt_text,
          schemaVersion: v.schema_version, status: v.status,
          createdBy: v.created_by, notes: v.notes, createdAt: v.created_at,
        })),
        evalCases: evalRes.rows.map((e: any) => ({
          id: e.id, label: e.label, promptVersion: e.prompt_version,
          inputSignals: e.input_signals, expectedOutput: e.expected_output,
          validateRules: e.validate_rules, createdAt: e.created_at,
        })),
        createdAt: r.created_at, updatedAt: r.updated_at,
      },
    });
  });

  // ── Create prompt ──────────────────────────────────
  app.post('/v1/admin/prompts', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const body = request.body as {
      name: string; slug?: string; description?: string; description_long?: string;
      prompt_text?: string; schema_id?: string; context_window?: string;
    } | null;
    if (!body?.name) return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'name required' } });

    const slug = body.slug || body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const user = request.jwtUser!;
    const [created] = await db.insert(adminPrompts).values({
      name: body.name, slug, description: body.description ?? '',
      descriptionLong: body.description_long ?? '',
      createdBy: user.userId, contextWindow: body.context_window ?? 'default',
      schemaId: body.schema_id ?? null,
    }).returning();

    if (body.prompt_text && created?.id) {
      const pool = getPool(db);
      if (pool) {
        await pool.query(
          `INSERT INTO ai_prompt_versions (prompt_id, version, prompt_text, schema_version, status, created_by, notes) VALUES ($1, 1, $2, 1, 'active', $3, 'Initial version')`,
          [created.id, body.prompt_text, user.userId],
        );
      }
    }

    await auditLog(user.userId, 'prompt.create', created?.id ?? 'unknown', { name: body.name });
    return reply.status(201).send({ data: { id: created?.id, name: body.name, slug } });
  });

  // ── Update prompt metadata ─────────────────────────
  app.patch('/v1/admin/prompts/:id', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string; description?: string; description_long?: string;
      context_window?: string; schema_id?: string;
    } | null;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body?.name) updates.name = body.name;
    if (body?.description !== undefined) updates.description = body.description;
    if (body?.description_long !== undefined) updates.descriptionLong = body.description_long;
    if (body?.context_window) updates.contextWindow = body.context_window;
    if (body?.schema_id !== undefined) updates.schemaId = body.schema_id;

    const [updated] = await db.update(adminPrompts).set(updates).where(eq(adminPrompts.id, id)).returning();
    if (!updated) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Prompt not found' } });

    const user = request.jwtUser!;
    await auditLog(user.userId, 'prompt.update', id, body ?? {});
    return reply.status(200).send({ data: { id, ...body } });
  });

  // ── Toggle prompt status ───────────────────────────
  app.patch('/v1/admin/prompts/:id/status', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string } | null;
    if (!body?.status || !['active', 'draft'].includes(body.status))
      return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'status must be active or draft' } });

    const [updated] = await db.update(adminPrompts).set({ status: body.status, updatedAt: new Date() }).where(eq(adminPrompts.id, id)).returning();
    if (!updated) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Prompt not found' } });

    const user = request.jwtUser!;
    await auditLog(user.userId, 'prompt.status', id, { status: body.status });
    return reply.status(200).send({ data: { id, status: body.status } });
  });

  // ── List versions ──────────────────────────────────
  app.get('/v1/admin/prompts/:id/versions', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: [] });

    const result = await pool.query('SELECT * FROM ai_prompt_versions WHERE prompt_id = $1 ORDER BY version DESC', [id]);
    return reply.status(200).send({
      data: result.rows.map((r: any) => ({
        id: r.id, version: r.version, promptText: r.prompt_text,
        schemaVersion: r.schema_version, status: r.status,
        createdBy: r.created_by, notes: r.notes, createdAt: r.created_at,
      })),
    });
  });

  // ── Create new version ─────────────────────────────
  app.post('/v1/admin/prompts/:id/versions', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { prompt_text: string; notes?: string; schema_version?: number } | null;
    if (!body?.prompt_text) return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'prompt_text required' } });

    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const promptRes = await pool.query('SELECT version FROM admin_prompts WHERE id = $1', [id]);
    if (!promptRes.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Prompt not found' } });

    const currentVer = parseInt(String((promptRes.rows[0] as any).version).replace(/^v/, ''), 10) || 0;
    const nextVersion = currentVer + 1;
    const user = request.jwtUser!;

    await pool.query('UPDATE ai_prompt_versions SET status = $1 WHERE prompt_id = $2 AND status = $3', ['archived', id, 'active']);
    await pool.query(
      `INSERT INTO ai_prompt_versions (prompt_id, version, prompt_text, schema_version, status, created_by, notes) VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
      [id, nextVersion, body.prompt_text, body.schema_version ?? 1, user.userId, body.notes ?? ''],
    );
    await db.update(adminPrompts).set({ version: String(nextVersion), updatedAt: new Date() }).where(eq(adminPrompts.id, id));

    await auditLog(user.userId, 'prompt.version.create', id, { version: nextVersion });
    return reply.status(201).send({ data: { id, version: nextVersion, status: 'active' } });
  });

  // ── Activate specific version ──────────────────────
  app.patch('/v1/admin/prompts/:id/versions/:version/activate', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id, version } = request.params as { id: string; version: string };
    const ver = parseInt(version, 10);
    if (isNaN(ver)) return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'version must be a number' } });

    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const vRes = await pool.query('SELECT id FROM ai_prompt_versions WHERE prompt_id = $1 AND version = $2', [id, ver]);
    if (!vRes.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Version not found' } });

    const user = request.jwtUser!;
    await pool.query('UPDATE ai_prompt_versions SET status = $1 WHERE prompt_id = $2 AND status = $3', ['archived', id, 'active']);
    await pool.query('UPDATE ai_prompt_versions SET status = $1 WHERE prompt_id = $2 AND version = $3', ['active', id, ver]);
    await db.update(adminPrompts).set({ activeVersion: String(ver), updatedAt: new Date() }).where(eq(adminPrompts.id, id));

    await auditLog(user.userId, 'prompt.version.activate', id, { version: ver });
    return reply.status(200).send({ data: { id, activeVersion: ver } });
  });

  // ── List eval cases ────────────────────────────────
  app.get('/v1/admin/prompts/:id/eval-cases', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: [] });

    const result = await pool.query('SELECT * FROM ai_prompt_eval_cases WHERE prompt_id = $1 ORDER BY created_at', [id]);
    return reply.status(200).send({
      data: result.rows.map((r: any) => ({
        id: r.id, label: r.label, promptVersion: r.prompt_version,
        inputSignals: r.input_signals, expectedOutput: r.expected_output,
        validateRules: r.validate_rules, createdAt: r.created_at,
      })),
    });
  });

  // ── Create eval case ───────────────────────────────
  app.post('/v1/admin/prompts/:id/eval-cases', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      label: string; prompt_version?: number;
      input_signals?: Record<string, unknown>; expected_output?: Record<string, unknown>;
      validate_rules?: Record<string, unknown>;
    } | null;
    if (!body?.label) return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'label required' } });

    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const promptRes = await pool.query('SELECT active_version FROM admin_prompts WHERE id = $1', [id]);
    if (!promptRes.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Prompt not found' } });

    const pv = body.prompt_version ?? Number((promptRes.rows[0] as any).active_version) ?? 1;
    await pool.query(
      `INSERT INTO ai_prompt_eval_cases (prompt_id, prompt_version, label, input_signals, expected_output, validate_rules) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, pv, body.label, JSON.stringify(body.input_signals ?? {}), JSON.stringify(body.expected_output ?? {}), JSON.stringify(body.validate_rules ?? {})],
    );

    return reply.status(201).send({ data: { id, label: body.label, promptVersion: pv } });
  });

  // ── Schemas ────────────────────────────────────────
  app.get('/v1/admin/schemas', { preHandler: [auth, superadmin] }, async (_request, reply) => {
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: [] });

    const result = await pool.query('SELECT id, name, schema_type, version, created_at FROM ai_prompt_schemas ORDER BY created_at');
    return reply.status(200).send({
      data: result.rows.map((r: any) => ({
        id: r.id, name: r.name, type: r.schema_type, version: r.version, createdAt: r.created_at,
      })),
    });
  });

  // ── Prompt performance metrics from ai_jobs_audit ──
  app.get('/v1/admin/prompts/:id/metrics', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: {} });

    const promptRes = await pool.query('SELECT name FROM admin_prompts WHERE id = $1', [id]);
    if (!promptRes.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Prompt not found' } });
    const promptName = (promptRes.rows[0] as any).name;

    const metricsRes = await pool.query(`
      SELECT
        COUNT(*)::int as total_runs,
        COUNT(*) FILTER (WHERE outcome = 'succeeded')::int as succeeded,
        COUNT(*) FILTER (WHERE outcome = 'error')::int as errors,
        COUNT(*) FILTER (WHERE outcome = 'rate_limited')::int as rate_limited,
        COUNT(*) FILTER (WHERE outcome = 'schema_repair')::int as schema_repairs,
        ROUND(AVG(latency_ms))::int as avg_latency_ms,
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms))::int as p95_latency_ms,
        ROUND(AVG(request_token_estimate))::int as avg_tokens_in,
        ROUND(AVG(COALESCE(response_token_count, 0)))::int as avg_tokens_out,
        ROUND(AVG(request_token_estimate) * 0.000015, 6) as avg_cost_usd,
        MAX(created_at) as last_run_at
      FROM ai_jobs_audit WHERE prompt_template_id = $1
    `, [promptName]);

    const dailyRes = await pool.query(`
      SELECT DATE(created_at) as date, COUNT(*)::int as runs,
        COUNT(*) FILTER (WHERE outcome = 'succeeded')::int as succeeded,
        ROUND(AVG(latency_ms))::int as avg_latency
      FROM ai_jobs_audit WHERE prompt_template_id = $1
      GROUP BY DATE(created_at) ORDER BY date DESC LIMIT 14
    `, [promptName]);

    const m = metricsRes.rows[0] as any;
    return reply.status(200).send({
      data: {
        totalRuns: m?.total_runs ?? 0, succeeded: m?.succeeded ?? 0,
        errors: m?.errors ?? 0, rateLimited: m?.rate_limited ?? 0,
        schemaRepairs: m?.schema_repairs ?? 0,
        successRate: m?.total_runs > 0 ? Math.round((m.succeeded / m.total_runs) * 100) : 0,
        latency: { avg: m?.avg_latency_ms ?? 0, p95: m?.p95_latency_ms ?? 0 },
        tokens: { avgIn: m?.avg_tokens_in ?? 0, avgOut: m?.avg_tokens_out ?? 0 },
        cost: { avgUsd: Number(m?.avg_cost_usd ?? 0) },
        lastRunAt: m?.last_run_at,
        daily: dailyRes.rows.map((d: any) => ({
          date: d.date, runs: d.runs, succeeded: d.succeeded, avgLatency: d.avg_latency,
        })),
      },
    });
  });

  // ── Submit feedback ────────────────────────────────
  app.post('/v1/admin/prompts/:id/feedback', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { rating: number; comment?: string; tags?: string[] } | null;
    if (!body?.rating || body.rating < 1 || body.rating > 5)
      return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'rating must be 1-5' } });

    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const promptRes = await pool.query('SELECT name FROM admin_prompts WHERE id = $1', [id]);
    if (!promptRes.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Prompt not found' } });

    const promptName = (promptRes.rows[0] as any).name;
    const user = request.jwtUser!;

    await pool.query(
      `INSERT INTO ai_feedback (workspace_id, user_id, prompt_template_id, rating, comment, tags) VALUES ($1, $2, $3, $4, $5, $6)`,
      ['admin', user.userId, promptName, body.rating, body.comment ?? null, JSON.stringify(body.tags ?? [])],
    );

    await auditLog(user.userId, 'prompt.feedback', id, { rating: body.rating });
    return reply.status(201).send({ data: { id, rating: body.rating } });
  });

  // ── Get feedback metrics ───────────────────────────
  app.get('/v1/admin/prompts/:id/feedback', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: { feedback: [], metrics: {} } });

    const promptRes = await pool.query('SELECT name FROM admin_prompts WHERE id = $1', [id]);
    if (!promptRes.rows[0]) return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Prompt not found' } });

    const promptName = (promptRes.rows[0] as any).name;

    const feedbackRes = await pool.query(
      `SELECT id, rating, comment, tags, created_at FROM ai_feedback WHERE prompt_template_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [promptName],
    );

    const metricsRes = await pool.query(`
      SELECT COUNT(*)::int as total, ROUND(AVG(rating), 2)::numeric as avg,
        COUNT(*) FILTER (WHERE rating = 1)::int as r1,
        COUNT(*) FILTER (WHERE rating = 2)::int as r2,
        COUNT(*) FILTER (WHERE rating = 3)::int as r3,
        COUNT(*) FILTER (WHERE rating = 4)::int as r4,
        COUNT(*) FILTER (WHERE rating = 5)::int as r5
      FROM ai_feedback WHERE prompt_template_id = $1
    `, [promptName]);

    const m = metricsRes.rows[0] as any;
    return reply.status(200).send({
      data: {
        feedback: feedbackRes.rows.map((r: any) => ({
          id: r.id, rating: r.rating, comment: r.comment, tags: r.tags, createdAt: r.created_at,
        })),
        metrics: {
          totalRatings: m?.total ?? 0, avgRating: Number(m?.avg ?? 0),
          distribution: { 1: m?.r1 ?? 0, 2: m?.r2 ?? 0, 3: m?.r3 ?? 0, 4: m?.r4 ?? 0, 5: m?.r5 ?? 0 },
        },
      },
    });
  });

  // ── Learning signals ───────────────────────────────
  app.get('/v1/admin/learning-signals', { preHandler: [auth, superadmin] }, async (_request, reply) => {
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: [] });

    const result = await pool.query(`
      SELECT prompt_template_id, pattern, frequency, avg_rating, suggested_action FROM ai_learning_signals ORDER BY avg_rating ASC LIMIT 20
    `).catch(() => ({ rows: [] }));

    return reply.status(200).send({ data: result.rows });
  });
}
