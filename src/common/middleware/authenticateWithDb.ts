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
  const result = await pool.query('SELECT suspended_at IS NOT NULL AS suspended FROM jwt_users WHERE id = $1', [
    auth.userId,
  ]);
  const row = (result.rows as Array<{ suspended: boolean | string }>)[0];
  if (row && (row.suspended === true || row.suspended === 't' || row.suspended === 'true')) {
    throwApiError('account_suspended', 'Akun ditangguhkan. Hubungi administrator.');
  }
  return auth;
}
