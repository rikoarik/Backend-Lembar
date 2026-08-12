/**
 * TDD: OtpService unit tests.
 *
 * Uses an in-memory pool mock — no real DB required.
 * Covers: happy path, expired OTP, rate limit, replay attack.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OtpService } from '../../src/modules/auth/application/OtpService.js';
import { ApiError } from '../../src/common/errors/envelope.js';

// ── Pool mock ────────────────────────────────────────────────────────────────
function makePool(rows: Record<string, unknown>[][] = []) {
  let callIdx = 0;
  return {
    query: vi.fn(async () => ({ rows: rows[callIdx++] ?? [] })),
  };
}

// OtpService accesses pool via getPool(db). We side-step by injecting db directly.
// getPool is exported from db.ts; we mock the module so getPool returns our fake pool.
vi.mock('../../src/infrastructure/database/db.js', () => ({
  getPool: vi.fn(),
}));

import { getPool } from '../../src/infrastructure/database/db.js';

// ── fetch mock (WA send — fire-and-forget) ───────────────────────────────────
vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));

// ── helpers ──────────────────────────────────────────────────────────────────
function makeService(pool: ReturnType<typeof makePool>, now?: () => Date) {
  vi.mocked(getPool).mockReturnValue(pool as never);
  return new OtpService({} as never, now);
}

// ── tests ────────────────────────────────────────────────────────────────────
describe('OtpService.request', () => {
  it('happy path: stores OTP and sends WA message', async () => {
    const pool = makePool([
      [{ count: '0' }],  // rate check
      [],                // INSERT
    ]);
    const svc = makeService(pool);
    const result = await svc.request('6281234567890');
    expect(result.expiresAt).toBeInstanceOf(Date);
    // INSERT was called
    expect(pool.query).toHaveBeenCalledTimes(2);
    // fetch called for WA
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });

  it('rate limit: throws RATE_LIMITED after 3 OTPs in window', async () => {
    const pool = makePool([[{ count: '3' }]]);
    const svc = makeService(pool);
    await expect(svc.request('6281234567890')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    // No INSERT attempted
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe('OtpService.verify', () => {
  it('happy path: marks used_at and returns phone', async () => {
    // We need bcrypt to actually work — generate a real hash for "123456"
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('123456', 4); // cost 4 for test speed

    const pool = makePool([
      [{ id: 'uuid-1', code_hash: hash }], // SELECT
      [],                                   // UPDATE used_at
    ]);
    const svc = makeService(pool);
    const result = await svc.verify('6281234567890', '123456');
    expect(result.phone).toBe('6281234567890');
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('expired / not found: throws VALIDATION_FAILED', async () => {
    const pool = makePool([[]]); // no rows = expired or not found
    const svc = makeService(pool);
    await expect(svc.verify('6281234567890', '123456')).rejects.toBeInstanceOf(ApiError);
  });

  it('wrong code: throws VALIDATION_FAILED', async () => {
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('999999', 4);

    const pool = makePool([[{ id: 'uuid-1', code_hash: hash }]]);
    const svc = makeService(pool);
    await expect(svc.verify('6281234567890', '111111')).rejects.toBeInstanceOf(ApiError);
  });

  it('replay attack: same OTP cannot be used twice (used_at set → SELECT returns nothing)', async () => {
    // Second call: SELECT finds no unused row
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('123456', 4);

    // First verify succeeds
    const pool1 = makePool([[{ id: 'uuid-1', code_hash: hash }], []]);
    const svc1 = makeService(pool1);
    await svc1.verify('6281234567890', '123456');

    // Second verify: pool returns empty (simulates used_at IS NOT NULL filter)
    const pool2 = makePool([[]]);
    const svc2 = makeService(pool2);
    await expect(svc2.verify('6281234567890', '123456')).rejects.toBeInstanceOf(ApiError);
  });
});
