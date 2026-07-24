import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyJwt, type JwtPayload } from '../../modules/auth/infrastructure/jwtMultiRole.js';
import { throwApiError } from '../errors/apiError.js';
import type { UserRole } from '../../modules/auth/persistence/jwtUsersSchema.js';

declare module 'fastify' {
  interface FastifyRequest {
    jwtUser?: JwtPayload;
  }
}

export interface JwtAuthMiddlewareOptions {
  secret: string;
}

export function createJwtAuthMiddleware(options: JwtAuthMiddlewareOptions) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const auth = request.headers.authorization;
    if (!auth) {
      throwApiError('missing_token', 'Authorization header diperlukan');
    }

    const parts = auth.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      throwApiError('invalid_auth_format', 'Format: Authorization: Bearer <token>');
    }

    const token = parts[1]!;
    try {
      const payload = verifyJwt(token, options.secret);
      request.jwtUser = payload;
    } catch (error) {
      throwApiError('invalid_token', 'Token tidak valid atau expired');
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
