/**
 * BUG-21 — POST /v1/workspaces/:ws/assessments must accept `reviewMode`,
 * validate it, and thread it into AssessmentService.createConfig so it can be
 * persisted in the version's immutable config snapshot.
 */
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';
import { registerAssessmentRoutes } from '../../../src/modules/assessments/adapters/http/routes.js';

const SECRET = 'assessment-review-mode-secret';
const WORKSPACE = 'ws-review-mode';
const token = generateJwt(
  {
    userId: 'user-owner',
    email: 'owner@example.test',
    roles: ['teacher'],
    workspaceId: WORKSPACE,
  },
  { secret: SECRET, expiryDays: 1 },
);
const auth = { authorization: `Bearer ${token}` };
const URL = `/v1/workspaces/${WORKSPACE}/assessments`;

function basePayload(extra: Record<string, unknown> = {}) {
  return {
    title: 'Ulangan Harian Matematika',
    curriculumVersionId: 'curriculum-v1',
    gradeId: 'grade-7',
    subjectId: 'subject-math',
    sourceUploadIds: [],
    blueprintItems: [{ sequence: 1, questionType: 'essay', difficulty: 'easy' }],
    ...extra,
  };
}

async function appWithRoutes() {
  const app = Fastify({ logger: false });
  const createConfig = vi.fn(async (_input: Record<string, unknown>) => ({
    assessment: { id: 'a-1', workspaceId: WORKSPACE },
    version: { id: 'v-1', version: 1 },
    blueprintItems: [],
    idempotent: false,
  }));
  const assessment = {
    createConfig,
    listAssessments: vi.fn(async () => []),
    getAssessment: vi.fn(async () => ({ assessment: {}, version: null, blueprintItems: [] })),
  };
  await registerAssessmentRoutes(app, assessment as never, { jwtSecret: SECRET });
  await app.ready();
  return { app, createConfig };
}

describe('assessment create route — reviewMode (BUG-21)', () => {
  it('forwards reviewMode: "detail" to the service', async () => {
    const { app, createConfig } = await appWithRoutes();
    const response = await app.inject({
      method: 'POST',
      url: URL,
      headers: auth,
      payload: basePayload({ reviewMode: 'detail' }),
    });

    expect(response.statusCode).toBe(201);
    expect(createConfig).toHaveBeenCalledTimes(1);
    expect(createConfig.mock.calls[0]![0]).toMatchObject({ reviewMode: 'detail' });
  });

  it('forwards reviewMode: "quick" to the service', async () => {
    const { app, createConfig } = await appWithRoutes();
    const response = await app.inject({
      method: 'POST',
      url: URL,
      headers: auth,
      payload: basePayload({ reviewMode: 'quick' }),
    });

    expect(response.statusCode).toBe(201);
    expect(createConfig.mock.calls[0]![0]).toMatchObject({ reviewMode: 'quick' });
  });

  it('accepts a request without reviewMode (legacy clients)', async () => {
    const { app, createConfig } = await appWithRoutes();
    const response = await app.inject({
      method: 'POST',
      url: URL,
      headers: auth,
      payload: basePayload(),
    });

    expect(response.statusCode).toBe(201);
    expect(createConfig.mock.calls[0]![0]).toMatchObject({ reviewMode: null });
  });

  it('rejects an unknown reviewMode with 400 and a field error', async () => {
    const { app, createConfig } = await appWithRoutes();
    const response = await app.inject({
      method: 'POST',
      url: URL,
      headers: auth,
      payload: basePayload({ reviewMode: 'verbose' }),
    });

    expect(response.statusCode).toBe(400);
    expect(createConfig).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      error: {
        code: 'VALIDATION_FAILED',
        fieldErrors: { reviewMode: ['invalid_review_mode'] },
      },
    });
  });
});
