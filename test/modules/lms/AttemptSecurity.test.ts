/**
 * LMS-G — Attempt security: per-IP rate limit + duplicate-submit guard.
 *
 * 3 tests:
 * 1. Normal start — returns 201
 * 2. Rate limit exceeded (6th attempt from same IP on same assessment) — returns 429
 * 3. Duplicate submit (submit already-submitted attempt) — returns 409
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';

import { registerAttemptRoutes, attemptRateLimitStore } from '../../../src/modules/lms/adapters/http/attemptRoutes.js';
import { AttemptService } from '../../../src/modules/lms/application/AttemptService.js';
import { InMemoryAttemptStore } from '../../../src/modules/lms/persistence/InMemoryAttemptStore.js';

const ASSESSMENT_ID = 'assess-security-001';

function makeApp() {
  const store = new InMemoryAttemptStore();
  const service = new AttemptService({ guestStore: store });
  const app = Fastify();
  void registerAttemptRoutes(app, service);
  return { app, store, service };
}

describe('AttemptSecurity', () => {
  beforeEach(() => {
    // Reset rate-limit state between tests
    attemptRateLimitStore.clear();
  });

  it('allows a normal start attempt and returns 201', async () => {
    const { app } = makeApp();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/assessments/${ASSESSMENT_ID}/attempts`,
      payload: { guestName: 'Budi Santoso' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string } }>();
    expect(body.data.id).toBeTruthy();
  });

  it('returns 429 after 5 attempts from same IP on same assessment within window', async () => {
    const { app } = makeApp();

    // First 5 should succeed
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/assessments/${ASSESSMENT_ID}/attempts`,
        payload: { guestName: `Guest ${i}` },
      });
      expect(res.statusCode).toBe(201);
    }

    // 6th from same IP must be blocked
    const res = await app.inject({
      method: 'POST',
      url: `/v1/assessments/${ASSESSMENT_ID}/attempts`,
      payload: { guestName: 'Guest 6' },
    });

    expect(res.statusCode).toBe(429);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('returns 409 when submitting an already-submitted attempt', async () => {
    const { app, service } = makeApp();

    // Start an attempt via service directly (bypasses rate limit)
    const attempt = await service.startGuestAttempt(ASSESSMENT_ID, 'Siti Rahayu');

    // First submit — should succeed
    const first = await app.inject({
      method: 'PUT',
      url: `/v1/attempts/${attempt.id}/submit`,
      payload: { answers: { 'q-1': 'A' } },
    });
    expect(first.statusCode).toBe(200);

    // Second submit — duplicate, must be 409
    const second = await app.inject({
      method: 'PUT',
      url: `/v1/attempts/${attempt.id}/submit`,
      payload: { answers: { 'q-1': 'B' } },
    });

    expect(second.statusCode).toBe(409);
    const body = second.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('STATE_CONFLICT');
  });
});
