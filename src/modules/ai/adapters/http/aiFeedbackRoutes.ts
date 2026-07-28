/**
 * AI Feedback routes — end-user (subscriber) surface for the learning loop.
 *
 * Why a separate module: admin/prompts routes are superadmin-only and treat
 * `workspace_id='admin'`. End users (teachers, schools) need their own
 * feedback channel so ratings get attributed to the actual workspace and
 * populate the same `ai_feedback` table the learning signal detector reads.
 *
 * Endpoints:
 *   POST /v1/ai/feedback              — submit rating (1..5) + comment + tags
 *   GET  /v1/ai/feedback/summary      — my feedback history + aggregate metrics
 *   GET  /v1/ai/learning-signals      — signals the detector finds (read-only)
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool, type Database } from '../../../../infrastructure/database/db.js';
import { createJwtAuthMiddleware } from '../../../../common/middleware/jwtMultiRoleAuth.js';

export interface RegisterAiFeedbackRoutesOptions {
  db: Database;
  jwtSecret: string;
}

interface SubmitBody {
  promptTemplateId: string;
  jobId?: string | null;
  rating: number;
  comment?: string | null;
  tags?: string[];
}

export async function registerAiFeedbackRoutes(
  app: FastifyInstance,
  options: RegisterAiFeedbackRoutesOptions,
): Promise<void> {
  const { db, jwtSecret } = options;
  const auth = createJwtAuthMiddleware({ secret: jwtSecret, db });

  app.post('/v1/ai/feedback', { preHandler: [auth] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.jwtUser;
    if (!user) return reply.status(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Login required' } });
    const workspaceId = (user as any).workspaceId as string | undefined;
    if (!workspaceId) {
      return reply.status(400).send({ error: { code: 'WORKSPACE_REQUIRED', message: 'Workspace context missing' } });
    }

    const body = (request.body as SubmitBody | null) ?? null;
    if (!body || typeof body.promptTemplateId !== 'string' || body.promptTemplateId.length === 0) {
      return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'promptTemplateId is required' } });
    }
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'rating must be integer 1..5' } });
    }

    const pool = getPool(db);
    if (!pool) return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Database not available' } });

    const tags = Array.isArray(body.tags) ? body.tags.slice(0, 10).map(String) : [];
    const insert = await pool.query(
      `INSERT INTO ai_feedback (workspace_id, user_id, prompt_template_id, job_id, rating, comment, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [
        workspaceId,
        user.userId,
        body.promptTemplateId,
        body.jobId ?? null,
        rating,
        body.comment ? String(body.comment).slice(0, 1000) : null,
        JSON.stringify(tags),
      ],
    );

    return reply.status(201).send({
      data: {
        id: (insert.rows[0] as any).id,
        rating,
        createdAt: (insert.rows[0] as any).created_at,
      },
    });
  });

  app.get('/v1/ai/feedback/summary', { preHandler: [auth] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.jwtUser;
    if (!user) return reply.status(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Login required' } });
    const workspaceId = (user as any).workspaceId as string | undefined;
    if (!workspaceId) {
      return reply.status(200).send({ data: { totalRatings: 0, avgRating: 0, recent: [] } });
    }
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: { totalRatings: 0, avgRating: 0, recent: [] } });

    const metrics = await pool.query(
      `SELECT COUNT(*)::int as total, ROUND(AVG(rating), 2)::numeric as avg
         FROM ai_feedback WHERE workspace_id = $1`,
      [workspaceId],
    );
    const recent = await pool.query(
      `SELECT id, prompt_template_id, job_id, rating, comment, tags, created_at
         FROM ai_feedback WHERE workspace_id = $1
        ORDER BY created_at DESC LIMIT 20`,
      [workspaceId],
    );
    const m = metrics.rows[0] as any;
    return reply.status(200).send({
      data: {
        totalRatings: m?.total ?? 0,
        avgRating: Number(m?.avg ?? 0),
        recent: recent.rows.map((r: any) => ({
          id: r.id,
          promptTemplateId: r.prompt_template_id,
          jobId: r.job_id,
          rating: r.rating,
          comment: r.comment,
          tags: r.tags,
          createdAt: r.created_at,
        })),
      },
    });
  });

  // Learning signals surfaced read-only so the FE can show "AI lagi belajar" without superadmin scope.
  app.get('/v1/ai/learning-signals', { preHandler: [auth] }, async (_request, reply) => {
    const pool = getPool(db);
    if (!pool) return reply.status(200).send({ data: [] });
    const result = await pool
      .query(
        `SELECT prompt_template_id, pattern, frequency, avg_rating, suggested_action
           FROM ai_learning_signals ORDER BY avg_rating ASC LIMIT 20`,
      )
      .catch(() => ({ rows: [] }));
    return reply.status(200).send({
      data: result.rows.map((r: any) => ({
        promptTemplateId: r.prompt_template_id,
        pattern: r.pattern,
        frequency: Number(r.frequency ?? 0),
        avgRating: Number(r.avg_rating ?? 0),
        suggestedAction: r.suggested_action,
      })),
    });
  });
}
