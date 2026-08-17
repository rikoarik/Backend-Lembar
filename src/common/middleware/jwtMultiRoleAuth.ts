import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyJwt, type JwtPayload } from '../../modules/auth/infrastructure/jwtMultiRole.js';
import { throwApiError } from '../errors/apiError.js';
import type { UserRole } from '../../modules/auth/persistence/jwtUsersSchema.js';
import { getPool, type Database } from '../../infrastructure/database/db.js';

declare module 'fastify' {
  interface FastifyRequest {
    jwtUser?: JwtPayload;
  }
}

export interface JwtAuthMiddlewareOptions {
  secret: string;
  /**
   * Optional DB pool provider. When supplied, the middleware rejects
   * requests whose user has `suspended_at IS NOT NULL` so that an existing
   * token cannot outlive a suspension. Caller is responsible for wiring the
   * same pool that owns the auth tables.
   */
  db?: Database | undefined;
}

export function createJwtAuthMiddleware(options: JwtAuthMiddlewareOptions) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const auth = request.headers.authorization;
    if (!auth) {
      throwApiError('missing_token', 'Authorization header diperlukan');
    }

    const parts = auth.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      throwApiError('invalid_auth_format', 'Format: Authorization: Bearer ***');
    }

    const token = parts[1]!;
    try {
      const payload = verifyJwt(token, options.secret);
      request.jwtUser = payload;
    } catch (error) {
      throwApiError('invalid_token', 'Token tidak valid atau expired');
    }

    const pool = options.db ? getPool(options.db) : null;
    if (pool && request.jwtUser?.userId) {
      try {
        const result = await pool.query(
          'SELECT suspended_at IS NOT NULL AS suspended FROM jwt_users WHERE id = $1',
          [request.jwtUser.userId],
        );
        const row = (result.rows as Array<{ suspended: boolean | string }>)[0];
        if (row && (row.suspended === true || row.suspended === 't' || row.suspended === 'true')) {
          throwApiError('account_suspended', 'Akun ditangguhkan. Hubungi administrator.');
        }
      } catch (err) {
        if ((err as { code?: string }).code === 'AUTH_REQUIRED') throw err;
        // If the query itself fails, allow the request rather than hiding an
        // outage behind auth.
      }
    }
  };
}

/**
 * Middleware untuk require minimal satu role dari daftar allowed roles (OR logic)
 * Contoh: requireRole(['school_admin', 'superadmin'])
 * → pass jika user punya school_admin ATAU superadmin
 */
export function requireRole(allowedRoles: UserRole[]) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const user = request.jwtUser;
    if (!user) {
      throwApiError('unauthorized', 'Authentication diperlukan');
    }

    // Check if user has at least one of the allowed roles
    const hasRole = user.roles.some((role: UserRole) => allowedRoles.includes(role));
    if (!hasRole) {
      throwApiError(
        'forbidden',
        `Akses ditolak. Required roles: ${allowedRoles.join(' atau ')}`,
      );
    }
  };
}
