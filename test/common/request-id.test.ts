import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/bootstrap/app.js';

describe('request-id middleware', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  it('propagates an incoming X-Request-Id header', async () => {
    const app = await buildApp({ logger: false });
    apps.push(app);
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'req_inbound_123' },
    });
    expect(res.headers['x-request-id']).toBe('req_inbound_123');
  });

  it('generates an opaque id when no header is provided', async () => {
    const app = await buildApp({ logger: false });
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/health' });
    const id = res.headers['x-request-id'];
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it('rejects malformed inbound ids and falls back to a generated one', async () => {
    const app = await buildApp({ logger: false });
    apps.push(app);
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'bad id with spaces and ; chars' },
    });
    const id = res.headers['x-request-id'];
    expect(id).not.toBe('bad id with spaces and ; chars');
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it('includes requestId in the error envelope on 404', async () => {
    const app = await buildApp({ logger: false });
    apps.push(app);
    const res = await app.inject({
      method: 'GET',
      url: '/no-such-route',
      headers: { 'x-request-id': 'req_404_xyz' },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string; requestId: string; retryable: boolean } };
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(body.error.requestId).toBe('req_404_xyz');
    expect(body.error.retryable).toBe(false);
  });
});
