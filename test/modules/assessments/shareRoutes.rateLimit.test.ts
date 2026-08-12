/**
 * TDD — GET /v1/shares/:token rate-limit preHandler
 * Verifikasi: setelah 30 request dari IP sama dalam 1 menit → 429 rate_limited
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerShareRoutes } from '../../../src/modules/assessments/adapters/http/shareRoutes.js';
import type { ShareLinkService } from '../../../src/modules/assessments/application/ShareLinkService.js';

function makeService(): ShareLinkService {
  return {
    validateToken: vi.fn().mockResolvedValue({
      id: 'link-1',
      token: 'abc123',
      assessmentId: 'asmnt-1',
      workspaceId: 'ws-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revokedAt: null,
      createdAt: new Date().toISOString(),
    }),
    createShareLink: vi.fn(),
    listByAssessment: vi.fn(),
    revokeShareLink: vi.fn(),
  } as unknown as ShareLinkService;
}

async function makeApp() {
  const app = Fastify();
  await registerShareRoutes(app, makeService(), { jwtSecret: 'test-secret' });
  await app.ready();
  return app;
}

describe('GET /v1/shares/:token — rate limit preHandler', () => {
  it('mengembalikan 429 setelah melebihi batas request', async () => {
    const app = await makeApp();
    try {
      // Kirim 30 request (batas) — semua harus sukses
      for (let i = 0; i < 30; i++) {
        const res = await app.inject({ method: 'GET', url: '/v1/shares/abc123' });
        expect(res.statusCode, `request ke-${i + 1} seharusnya 200`).toBe(200);
      }
      // Request ke-31 harus kena rate limit
      const limited = await app.inject({ method: 'GET', url: '/v1/shares/abc123' });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      const body = limited.json<{ code: string }>();
      expect(body.code).toBe('RATE_LIMITED');
    } finally {
      await app.close();
    }
  });
});
