import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { rateLimit } from '../../src/common/security/rateLimit.js';

describe('auth rate limiter', () => {
  it('returns 429 and Retry-After after the configured limit', async () => {
    const app = Fastify({ logger: false });
    app.post('/login', async (request, reply) => {
      rateLimit(request, reply, 'test-login', 2, 60_000);
      return reply.send({ ok: true });
    });

    expect((await app.inject({ method: 'POST', url: '/login' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/login' })).statusCode).toBe(200);
    const blocked = await app.inject({ method: 'POST', url: '/login' });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
  });

  it('does not share counters between Fastify instances', async () => {
    const makeApp = () => {
      const app = Fastify({ logger: false });
      app.post('/login', async (request, reply) => {
        rateLimit(request, reply, 'test-login', 1, 60_000);
        return reply.send({ ok: true });
      });
      return app;
    };
    const first = makeApp();
    const second = makeApp();
    expect((await first.inject({ method: 'POST', url: '/login' })).statusCode).toBe(200);
    expect((await second.inject({ method: 'POST', url: '/login' })).statusCode).toBe(200);
    await Promise.all([first.close(), second.close()]);
  });
});

// ponytail: counters are process-local; replace the store with Redis before horizontal API scaling.
