import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const authenticateWithDb = vi.hoisted(() => vi.fn());
vi.mock('../../../src/common/middleware/authenticateWithDb.js', () => ({ authenticateWithDb }));

import { registerJobRoutes } from '../../../src/infrastructure/queue/adapters/http/jobRoutes.js';

describe('registerJobRoutes', () => {
  it('forwards db to DB-aware auth helper for job submission', async () => {
    authenticateWithDb.mockResolvedValue({ tenantId: 't', workspaceId: 'w', userId: 'u', roles: ['subscriber'] });
    const app = Fastify();
    await app.register(registerJobRoutes, { Store: {} as never, jwtSecret: 's', db: {} as never });

    await app.inject({ method: 'POST', url: '/v1/jobs', headers: { authorization: 'Bearer x' }, payload: {} });
    expect(authenticateWithDb).toHaveBeenCalled();
    await app.close();
  });
});
