import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerAiFeedbackRoutes } from '../../../src/modules/ai/adapters/http/aiFeedbackRoutes.js';
import {
  createDatabase,
  closeDatabase,
  getPool,
  type Database,
} from '../../../src/infrastructure/database/db.js';
import { hashPassword } from '../../../src/modules/auth/infrastructure/password.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const JWT_SECRET = 'ai-feedback-route-test-secret';

describe.skipIf(!DATABASE_URL)('AI feedback routes', () => {
  let db: Database;
  let app: ReturnType<typeof Fastify>;
  const ids: { userId: string; feedbackId?: string }[] = [];
  const jobId = randomUUID();

  beforeAll(async () => {
    db = createDatabase({ connectionString: DATABASE_URL });
    app = Fastify({ logger: false });
    await registerAiFeedbackRoutes(app, { db, jwtSecret: JWT_SECRET });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    const pool = getPool(db);
    if (pool) {
      await pool.query('DELETE FROM ai_feedback WHERE user_id = ANY($1::text[])', [
        ids.map((i) => i.userId),
      ]);
      await pool.query('DELETE FROM ai_jobs_audit WHERE job_id = $1', [jobId]);
      await pool.query('DELETE FROM jwt_users WHERE id = ANY($1::uuid[])', [
        ids.map((i) => i.userId),
      ]);
    }
    await closeDatabase(db);
  });

  it('rejects generic assessment_output feedback without job resolution', async () => {
    const userId = randomUUID();
    ids.push({ userId });
    const pool = getPool(db)!;
    await pool.query(
      `INSERT INTO jwt_users (id, email, username, password_hash, name, roles)
       VALUES ($1, $2, $3, $4, $5, ARRAY['teacher']::text[])`,
      [
        userId,
        `${userId}@ai-feedback.test`,
        `teacher_${userId.slice(0, 8)}`,
        await hashPassword('Password1!'),
        'Teacher Test',
      ],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ai/feedback',
      headers: { authorization: `Bearer ${signJwt(userId)}` },
      payload: {
        promptTemplateId: 'assessment_output',
        rating: 4,
        comment: 'bagus',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
  });

  it('resolves prompt_template_id from ai_jobs_audit when jobId is present', async () => {
    const userId = randomUUID();
    ids.push({ userId });
    const pool = getPool(db)!;
    await pool.query(
      `INSERT INTO jwt_users (id, email, username, password_hash, name, roles)
       VALUES ($1, $2, $3, $4, $5, ARRAY['teacher']::text[])`,
      [
        userId,
        `${userId}@ai-feedback.test`,
        `teacher_${userId.slice(0, 8)}`,
        await hashPassword('Password1!'),
        'Teacher Test',
      ],
    );
    await pool.query(
      `INSERT INTO ai_jobs_audit (id, workspace_id, actor_id, prompt_template_id, schema_version, provider_model_id, driver, outcome, request_token_estimate, response_token_count, tokens_in_estimate, prompt_fingerprint, prompt_byte_length, response_fingerprint, response_byte_length, latency_ms, job_id, created_at)
       VALUES ($1, $2, $3, $4, 1, 'mock-model', 'mock', 'succeeded', 1, 1, 1, 'p', 1, 'r', 1, 1, $5, now())`,
      [randomUUID(), 'workspace-1', userId, 'question-generation-v1', jobId],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/ai/feedback',
      headers: { authorization: `Bearer ${signJwt(userId)}` },
      payload: {
        promptTemplateId: 'assessment_output',
        jobId,
        rating: 5,
        comment: 'bagus',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.id).toBeTruthy();

    const rows = await pool.query(
      'SELECT prompt_template_id, job_id FROM ai_feedback WHERE id = $1',
      [body.data.id],
    );
    expect(rows.rows[0]).toMatchObject({
      prompt_template_id: 'question-generation-v1',
      job_id: jobId,
    });
  });
});

function signJwt(userId: string): string {
  return jwt.sign(
    {
      userId,
      email: `${userId}@ai-feedback.test`,
      workspaceId: 'workspace-1',
      roles: ['teacher'],
    },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}
