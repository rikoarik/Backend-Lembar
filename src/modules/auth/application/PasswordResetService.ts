import { createHash, randomBytes } from 'node:crypto';

import { ApiError } from '../../../common/errors/envelope.js';
import { getPool, type Database } from '../../../infrastructure/database/db.js';
import { hashPassword } from '../infrastructure/password.js';

const RESET_TTL_MS = 60 * 60 * 1000;
const PASSWORD_UPPER = /[A-Z]/;
const PASSWORD_NUMBER = /\d/;
const PASSWORD_SYMBOL = /[^A-Za-z0-9]/;

export type IssuedPasswordReset = {
  token: string;
  expiresAt: Date;
};

export class PasswordResetService {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(userId: string): Promise<IssuedPasswordReset> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database not available');

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + RESET_TTL_MS);
    await pool.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, hashToken(token), expiresAt],
    );
    return { token, expiresAt };
  }

  async apply(token: string, newPassword: string): Promise<void> {
    if (!token || !isValidPassword(newPassword)) {
      throw invalidReset('Token atau kata sandi tidak valid');
    }

    const pool = getPool(this.db);
    if (!pool) throw new Error('Database not available');
    const passwordHash = await hashPassword(newPassword);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const reset = await client.query<{ id: string; user_id: string }>(
        `SELECT id, user_id
         FROM password_resets
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
         FOR UPDATE`,
        [hashToken(token), this.now()],
      );
      const row = reset.rows[0];
      if (!row) throw invalidReset('Token reset tidak valid atau kedaluwarsa');

      await client.query(
        `UPDATE jwt_users
         SET password_hash = $1, needs_password_setup = false, updated_at = now()
         WHERE id = $2`,
        [passwordHash, row.user_id],
      );
      await client.query('UPDATE password_resets SET used_at = $1 WHERE id = $2', [
        this.now(),
        row.id,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isValidPassword(password: string): boolean {
  return (
    password.length >= 12 &&
    PASSWORD_UPPER.test(password) &&
    PASSWORD_NUMBER.test(password) &&
    PASSWORD_SYMBOL.test(password)
  );
}

function invalidReset(message: string): ApiError {
  return new ApiError({
    code: 'VALIDATION_FAILED',
    message,
    requestId: 'pending',
  });
}
