import { describe, expect, it, vi } from 'vitest';

const createJwtAuthMiddleware = vi.hoisted(() => vi.fn());
vi.mock('../../../src/common/middleware/jwtMultiRoleAuth.js', () => ({ createJwtAuthMiddleware }));

import { assessmentPrivateAuth } from '../../../src/modules/assessments/adapters/http/privateAuth.js';

describe('assessmentPrivateAuth', () => {
  it('forwards db to JWT auth middleware for suspended-account checks', () => {
    const authenticate = vi.fn();
    createJwtAuthMiddleware.mockReturnValue(authenticate);
    const db = {} as never;

    const handlers = assessmentPrivateAuth({ jwtSecret: 's', db });

    expect(handlers[0]).toBe(authenticate);
    expect(createJwtAuthMiddleware).toHaveBeenCalledWith({ secret: 's', db });
  });
});
