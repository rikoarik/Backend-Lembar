import { describe, expect, it, vi } from 'vitest';

const createJwtAuthMiddleware = vi.hoisted(() => vi.fn());
vi.mock('../../../src/common/middleware/jwtMultiRoleAuth.js', () => ({
  createJwtAuthMiddleware,
  requireRole: vi.fn(() => vi.fn()),
}));
vi.mock('../../../src/modules/auth/application/JwtMultiRoleAuthService.js', () => ({
  JwtMultiRoleAuthService: class {},
}));

import { registerJwtMultiRoleRoutes } from '../../../src/modules/auth/adapters/http/jwtMultiRoleRoutes.js';

describe('registerJwtMultiRoleRoutes', () => {
  it('forwards db to JWT middleware for suspended-account checks', async () => {
    const auth = vi.fn();
    createJwtAuthMiddleware.mockReturnValue(auth);
    const app = { post: vi.fn(), get: vi.fn(), patch: vi.fn() } as never;
    const db = {} as never;

    await registerJwtMultiRoleRoutes(app, { db, jwtSecret: 's', jwtExpiryDays: 7 });

    expect(createJwtAuthMiddleware).toHaveBeenCalledWith({ secret: 's', db });
  });
});
