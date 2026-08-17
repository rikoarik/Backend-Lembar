import { describe, expect, it, vi } from 'vitest';

const createJwtAuthMiddleware = vi.hoisted(() => vi.fn());
vi.mock('../../../src/common/middleware/jwtMultiRoleAuth.js', () => ({ createJwtAuthMiddleware }));

import { registerJobStatusRoutes } from '../../../src/modules/jobs/adapters/http/routes.js';

describe('registerJobStatusRoutes', () => {
  it('forwards db to JWT auth middleware for suspended-account checks', () => {
    const auth = vi.fn();
    createJwtAuthMiddleware.mockReturnValue(auth);
    const route = vi.fn();
    const app = { get: route, post: route } as never;
    const db = {} as never;
    const service = {} as never;

    registerJobStatusRoutes(app, service, { jwtSecret: 's', db });

    expect(createJwtAuthMiddleware).toHaveBeenCalledWith({ secret: 's', db });
  });
});
