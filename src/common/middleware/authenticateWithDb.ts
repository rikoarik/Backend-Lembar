import type { FastifyRequest } from 'fastify';

import type { Database } from '../../infrastructure/database/db.js';
import { throwApiError } from '../errors/apiError.js';
import { authenticate, type AuthenticateOptions, type AuthenticatedContext } from './authenticate.js';
import { getPool } from '../../infrastructure/database/db.js';

export interface AuthenticateWithDbOptions extends AuthenticateOptions {
  db?: Database | undefined;
}

export async function authenticateWithDb(
  request: FastifyRequest,
  options: AuthenticateWithDbOptions,
): Promise<AuthenticatedContext> {
  const auth = authenticate(request, options);
  if (!options.db || !auth.userId) return auth;
  const pool = getPool(options.db);
  if (!pool) return auth;
  const result = await pool.query(
    'SELECT suspended_at IS NOT NULL AS suspended, session_version FROM jwt_users WHERE id = $1',
    [auth.userId],
  );
  const row = (result.rows as Array<{ suspended: boolean | string; session_version?: number | string }>)[0];
  if (row && (row.suspended === true || row.suspended === 't' || row.suspended === 'true')) {
    throwApiError('account_suspended', 'Akun ditangguhkan. Hubungi administrator.');
  }
  // BUG-21: same revocation check as the JWT middleware — a token minted before
  // the last logout is no longer valid. Skipped when the column is not part of
  // the projection, so this cannot 401 every request by accident.
  const stored = row?.session_version;
  if (stored !== undefined && stored !== null && Number.isFinite(Number(stored))) {
    if (Number(stored) !== auth.sessionVersion) {
      throwApiError('invalid_token', 'Sesi sudah berakhir. Silakan masuk kembali.');
    }
  }
  return auth;
}
