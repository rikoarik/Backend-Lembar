import { describe, expect, it, vi } from 'vitest';

const verifyJwt = vi.hoisted(() => vi.fn());
const getPool = vi.hoisted(() => vi.fn());

vi.mock('../../../src/modules/auth/infrastructure/jwtMultiRole.js', () => ({ verifyJwt }));
vi.mock('../../../src/infrastructure/database/db.js', () => ({ getPool }));

import { createJwtAuthMiddleware } from '../../../src/common/middleware/jwtMultiRoleAuth.js';

describe('createJwtAuthMiddleware suspension check', () => {
  it('rejects suspended users when db returns a managed pool', async () => {
    verifyJwt.mockReturnValue({ userId: 'u1', roles: ['subscriber'], workspaceId: 'w1' });
    getPool.mockReturnValue({
      query: vi.fn().mockResolvedValue({ rows: [{ suspended: true }] }),
    });

    const middleware = createJwtAuthMiddleware({
      secret: 's',
      db: {} as never,
    });
    const req = { headers: { authorization: 'Bearer token' }, jwtUser: undefined } as never;

    await expect(middleware(req, {} as never)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('allows active users when db returns a managed pool', async () => {
    verifyJwt.mockReturnValue({ userId: 'u1', roles: ['subscriber'], workspaceId: 'w1' });
    getPool.mockReturnValue({
      query: vi.fn().mockResolvedValue({ rows: [{ suspended: false }] }),
    });

    const middleware = createJwtAuthMiddleware({
      secret: 's',
      db: {} as never,
    });
    const req = { headers: { authorization: 'Bearer token' }, jwtUser: undefined } as never;

    await expect(middleware(req, {} as never)).resolves.toBeUndefined();
  });
});
