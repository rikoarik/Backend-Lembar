import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  createDatabase,
  getPool,
  type Database,
} from '../../../src/infrastructure/database/db.js';
import { PasswordResetService } from '../../../src/modules/auth/application/PasswordResetService.js';
import { verifyPassword } from '../../../src/modules/auth/infrastructure/password.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const hasDb = DATABASE_URL.length > 0;

describe.skipIf(!hasDb)('password reset', () => {
  let db: Database;
  const userIds: string[] = [];

  beforeAll(() => {
    db = createDatabase({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    const pool = getPool(db);
    if (pool && userIds.length) {
      await pool.query('DELETE FROM jwt_users WHERE id = ANY($1::uuid[])', [userIds]);
    }
    await closeDatabase(db);
  });

  async function createUser(): Promise<string> {
    const id = randomUUID();
    userIds.push(id);
    const suffix = id.slice(0, 8);
    await getPool(db)!.query(
      `INSERT INTO jwt_users (id, email, username, password_hash, name, roles)
       VALUES ($1, $2, $3, $4, $5, ARRAY['subscriber']::text[])`,
      [id, `${suffix}@reset.test`, `reset_${suffix}`, '$2b$10$existing', 'Reset Test'],
    );
    return id;
  }

  it('generates a token and applies a new password once', async () => {
    const userId = await createUser();
    const service = new PasswordResetService(db);
    const issued = await service.issue(userId);

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 60 * 1000);

    await service.apply(issued.token, 'PasswordBaru1!');

    const result = await getPool(db)!.query<{ password_hash: string; needs_password_setup: boolean }>(
      'SELECT password_hash, needs_password_setup FROM jwt_users WHERE id = $1',
      [userId],
    );
    expect(await verifyPassword('PasswordBaru1!', result.rows[0]!.password_hash)).toBe(true);
    expect(result.rows[0]!.needs_password_setup).toBe(false);
    await expect(service.apply(issued.token, 'PasswordLain1!')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('rejects an expired token', async () => {
    const userId = await createUser();
    const issuedAt = new Date('2026-07-27T10:00:00.000Z');
    const issuer = new PasswordResetService(db, () => issuedAt);
    const issued = await issuer.issue(userId);
    const expiredConsumer = new PasswordResetService(
      db,
      () => new Date(issuedAt.getTime() + 60 * 60 * 1000 + 1),
    );

    await expect(expiredConsumer.apply(issued.token, 'PasswordBaru1!')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
