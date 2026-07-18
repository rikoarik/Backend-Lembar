import { afterAll, describe, expect, it } from 'vitest';
import { startApi } from '../../src/bootstrap/api.js';

describe('api smoke (real listen)', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterAll(async () => {
    if (shutdown) await shutdown();
  });

  it('serves GET /health on a real port', async () => {
    const app = await startApi({ port: 0, host: '127.0.0.1', logger: false });
    shutdown = async () => {
      await app.close();
    };
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('API did not bind a TCP port');

    const res = await fetch(`http://127.0.0.1:${String(address.port)}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('lembar-api');
  }, 15_000);
});
