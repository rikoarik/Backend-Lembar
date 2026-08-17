import { describe, expect, it, vi } from 'vitest';

const createJwtAuthMiddleware = vi.hoisted(() => vi.fn());
vi.mock('../../../src/common/middleware/jwtMultiRoleAuth.js', () => ({ createJwtAuthMiddleware }));

import { registerUploadsAuthHook } from '../../../src/modules/uploads/adapters/http/preHandler.js';

describe('registerUploadsAuthHook', () => {
  it('forwards db to jwt auth middleware', async () => {
    const authenticate = vi.fn();
    createJwtAuthMiddleware.mockReturnValue(authenticate);
    const addHook = vi.fn();
    const app = { addHook } as never;
    const db = { query: vi.fn() } as never;

    await registerUploadsAuthHook(app, { jwtSecret: 's', db });

    expect(createJwtAuthMiddleware).toHaveBeenCalledWith({ secret: 's', db });
    expect(addHook).toHaveBeenCalledTimes(1);
  });
});
