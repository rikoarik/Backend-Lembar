import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerJobRoutes } from '../../../src/infrastructure/queue/adapters/http/jobRoutes.js';
import { InMemoryQueueStore } from '../../../src/infrastructure/queue/adapters/memory-store.js';
import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';
import { QuotaExceededError } from '../../../src/modules/plans/domain/errors.js';

const secret = 'job-route-test-secret';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';

function token(overrides: Partial<{ workspaceId: string | null; userId: string }> = {}) {
  return generateJwt(
    {
      userId: overrides.userId ?? userId,
      email: 'guru@example.test',
      roles: ['teacher'],
      workspaceId: overrides.workspaceId === undefined ? workspaceId : overrides.workspaceId,
    },
    { secret, expiryDays: 1 },
  );
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    actorId: 'body-actor-must-not-be-trusted',
    operation: 'assessment_generation',
    idempotencyKey: 'generation-1',
    payload: { assessmentId: 'assessment-1' },
    ...overrides,
  };
}

function access(allowed = true) {
  const checks: Array<Record<string, string | undefined>> = [];
  const recorded: Array<Record<string, string>> = [];
  return {
    checks,
    recorded,
    service: {
      async assertGenerationAllowed(input: Record<string, string | undefined>) {
        checks.push(input);
        if (!allowed) throw new QuotaExceededError(workspaceId, 10, 10);
      },
      async recordGeneration(input: Record<string, string>) {
        if (!recorded.some((entry) => entry.idempotencyKey === input.idempotencyKey))
          recorded.push(input);
      },
    },
  };
}

async function appWith(service = access().service) {
  const app = Fastify();
  await app.register(registerJobRoutes, {
    Store: new InMemoryQueueStore(),
    jwtSecret: secret,
    generationAccess: service,
  });
  return app;
}

const apps: Array<Awaited<ReturnType<typeof appWith>>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('POST /v1/jobs assessment generation access boundary', () => {
  it('requires a valid JWT', async () => {
    const app = await appWith();
    apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/v1/jobs', payload: body() });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_REQUIRED');
  });

  it('rejects a body workspace different from the JWT workspace', async () => {
    const app = await appWith();
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { authorization: `Bearer ${token()}` },
      payload: body({ workspaceId: '33333333-3333-4333-8333-333333333333' }),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('PERMISSION_DENIED');
  });

  it('derives workspace and actor from JWT and forwards the trial device token', async () => {
    const gate = access();
    const app = await appWith(gate.service);
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { authorization: `Bearer ${token()}`, 'x-trial-device-token': 'browser-secret' },
      payload: body(),
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ workspaceId, actorId: userId, duplicate: false });
    expect(gate.checks).toEqual([
      { tenantId: workspaceId, workspaceId, userId, deviceToken: 'browser-secret' },
    ]);
  });

  it('rejects exhausted free quota without creating or recording a job', async () => {
    const gate = access(false);
    const app = await appWith(gate.service);
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { authorization: `Bearer ${token()}` },
      payload: body(),
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.message).toMatch(/kuota/i);
    expect(gate.recorded).toHaveLength(0);
  });

  it('records one usage idempotently by accepted job id', async () => {
    const gate = access();
    const app = await appWith(gate.service);
    apps.push(app);
    const request = {
      method: 'POST' as const,
      url: '/v1/jobs',
      headers: { authorization: `Bearer ${token()}` },
      payload: body(),
    };
    const first = await app.inject(request);
    const retry = await app.inject(request);
    expect(first.statusCode).toBe(202);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().jobId).toBe(first.json().jobId);
    expect(gate.recorded).toHaveLength(1);
    expect(gate.recorded[0]).toMatchObject({ tenantId: workspaceId, workspaceId, userId });
  });

  it('records once for concurrent submissions with the same idempotency key', async () => {
    const gate = access();
    const app = await appWith(gate.service);
    apps.push(app);
    const request = {
      method: 'POST' as const,
      url: '/v1/jobs',
      headers: { authorization: `Bearer ${token()}` },
      payload: body(),
    };
    const responses = await Promise.all([app.inject(request), app.inject(request)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 202]);
    expect(new Set(responses.map((response) => response.json().jobId)).size).toBe(1);
    expect(gate.recorded).toHaveLength(1);
  });

  it('does not quota-gate other job operations', async () => {
    const gate = access(false);
    const app = await appWith(gate.service);
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { authorization: `Bearer ${token()}` },
      payload: body({ operation: 'export_pdf' }),
    });
    expect(response.statusCode).toBe(202);
    expect(gate.checks).toHaveLength(0);
    expect(gate.recorded).toHaveLength(0);
  });
});
