import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type HealthResponse } from '../../src/bootstrap/app.js';

describe('api app', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  it('GET /health returns ok with secret-free fields', async () => {
    const app = await buildApp({ logger: false });
    apps.push(app);

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as HealthResponse;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('lembar-api');
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date');

    const forbidden = ['password', 'token', 'secret', 'api_key', 'apikey'];
    for (const f of forbidden) {
      expect(JSON.stringify(body).toLowerCase()).not.toContain(f);
    }
  });

  it('unknown routes return 404', async () => {
    const app = await buildApp({ logger: false });
    apps.push(app);

    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
  });
});
