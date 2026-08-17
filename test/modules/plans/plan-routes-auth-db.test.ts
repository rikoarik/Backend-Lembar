import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const authenticateWithDb = vi.hoisted(() => vi.fn());
vi.mock('../../../src/common/middleware/authenticateWithDb.js', () => ({ authenticateWithDb }));

import { registerPlanRoutes } from '../../../src/modules/plans/adapters/http/planRoutes.js';

describe('registerPlanRoutes', () => {
  it('forwards db to DB-aware auth helper for plan endpoints', async () => {
    authenticateWithDb.mockResolvedValue({ tenantId: 't', workspaceId: 'w', userId: 'u', roles: ['subscriber'] });
    const app = Fastify();
    await registerPlanRoutes(app, { getPlanSummary: vi.fn(), assertQuota: vi.fn() } as never, {
      jwtSecret: 's',
      db: {} as never,
      trials: { claim: vi.fn() } as never,
    });

    await app.inject({ method: 'GET', url: '/v1/me/plan', headers: { authorization: 'Bearer x' } });
    expect(authenticateWithDb).toHaveBeenCalled();
    await app.close();
  });
});
