/**
 * B6-04 — Ops & lead capture tests.
 *
 * Evidence covered:
 * - GET /v1/metrics: correct shape (requestCount, latencyP95Ms, queueDepth)
 * - POST /v1/leads: valid lead creates 201
 * - POST /v1/leads: validation errors → 400 with fieldErrors
 * - POST /v1/leads: rate limit → 429 after 3 submissions
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';

import { MetricsCollector } from '../../../src/modules/ops/application/MetricsCollector.js';
import {
  LeadCaptureService,
  InMemoryLeadStore,
} from '../../../src/modules/ops/application/LeadCaptureService.js';
import { registerOpsRoutes } from '../../../src/modules/ops/adapters/http/opsRoutes.js';

async function buildApp() {
  const metrics = new MetricsCollector();
  const store = new InMemoryLeadStore();
  const leads = new LeadCaptureService(store);

  const app = Fastify({ logger: false });
  await app.register((instance) => registerOpsRoutes(instance, { metrics, leads }));
  await app.ready();
  return { app, metrics, store, leads };
}

const VALID_LEAD = {
  name: 'Budi Santoso',
  email: 'budi@sekolah.id',
  school: 'SMA Negeri 1 Jakarta',
  role: 'teacher',
};

describe('B6-04 — Ops & lead capture', () => {
  // ─── GET /v1/metrics ──────────────────────────────────────────────────────

  describe('GET /v1/metrics', () => {
    it('returns correct shape with zero values initially', async () => {
      const { app } = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/v1/metrics' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveProperty('requestCount');
      expect(body.data).toHaveProperty('latencyP95Ms');
      expect(body.data).toHaveProperty('queueDepth');
      expect(body.data).toHaveProperty('capturedAt');
      expect(typeof body.data.requestCount).toBe('number');
      expect(typeof body.data.latencyP95Ms).toBe('number');
      expect(typeof body.data.queueDepth).toBe('number');
    });

    it('reflects recorded request counts', async () => {
      const { app, metrics } = await buildApp();
      metrics.recordRequest(50);
      metrics.recordRequest(100);
      metrics.recordRequest(200);

      const res = await app.inject({ method: 'GET', url: '/v1/metrics' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.requestCount).toBe(3);
    });

    it('reflects p95 latency correctly', async () => {
      const { app, metrics } = await buildApp();
      // 100 samples: 95th percentile at index 94 (sorted)
      for (let i = 1; i <= 100; i++) metrics.recordRequest(i * 10);

      const res = await app.inject({ method: 'GET', url: '/v1/metrics' });
      const body = res.json();
      // p95 of [10,20,...,1000] = 950ms
      expect(body.data.latencyP95Ms).toBe(950);
    });

    it('reflects queue depth', async () => {
      const { app, metrics } = await buildApp();
      metrics.setQueueDepth(5);

      const res = await app.inject({ method: 'GET', url: '/v1/metrics' });
      const body = res.json();
      expect(body.data.queueDepth).toBe(5);
    });
  });

  // ─── POST /v1/leads — valid ───────────────────────────────────────────────

  describe('POST /v1/leads — valid submission', () => {
    it('creates lead and returns 201', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/leads',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(VALID_LEAD),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.data).toHaveProperty('id');
      expect(body.data.email).toBe('budi@sekolah.id');
      expect(body.data.name).toBe('Budi Santoso');
    });

    it('normalizes email to lowercase', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/leads',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...VALID_LEAD, email: 'BUDI@SEKOLAH.ID' }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.data.email).toBe('budi@sekolah.id');
    });
  });

  // ─── POST /v1/leads — validation ─────────────────────────────────────────

  describe('POST /v1/leads — validation errors → 400', () => {
    it('rejects missing name', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/leads',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...VALID_LEAD, name: '' }),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.fieldErrors).toHaveProperty('name');
    });

    it('rejects invalid email', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/leads',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...VALID_LEAD, email: 'not-an-email' }),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.fieldErrors).toHaveProperty('email');
    });

    it('rejects missing school', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/leads',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...VALID_LEAD, school: 'x' }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects missing role', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/leads',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...VALID_LEAD, role: '' }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── POST /v1/leads — rate limit ─────────────────────────────────────────

  describe('POST /v1/leads — rate limit → 429', () => {
    it('allows 3 submissions, blocks the 4th', async () => {
      const { app } = await buildApp();

      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/leads',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...VALID_LEAD }),
        });
        expect(res.statusCode).toBe(201);
      }

      const res4 = await app.inject({
        method: 'POST',
        url: '/v1/leads',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...VALID_LEAD }),
      });
      expect(res4.statusCode).toBe(429);
      const body = res4.json();
      expect(body.error.code).toBe('RATE_LIMITED');
    });

    it('different emails are independent rate limits', async () => {
      const { app } = await buildApp();

      // Exhaust rate limit for email A
      for (let i = 0; i < 3; i++) {
        await app.inject({
          method: 'POST',
          url: '/v1/leads',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...VALID_LEAD, email: 'a@school.id' }),
        });
      }

      // Email B should still be allowed
      const resB = await app.inject({
        method: 'POST',
        url: '/v1/leads',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...VALID_LEAD, email: 'b@school.id' }),
      });
      expect(resB.statusCode).toBe(201);
    });
  });

  // ─── MetricsCollector unit tests ──────────────────────────────────────────

  describe('MetricsCollector', () => {
    it('p95 returns 0 with no samples', () => {
      const mc = new MetricsCollector();
      expect(mc.getP95Ms()).toBe(0);
    });

    it('queue depth increment/decrement', () => {
      const mc = new MetricsCollector();
      mc.incrementQueueDepth();
      mc.incrementQueueDepth();
      mc.decrementQueueDepth();
      expect(mc.getSnapshot().queueDepth).toBe(1);
    });
  });
});
