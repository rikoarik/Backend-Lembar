import type { FastifyRequest } from 'fastify';
import { verifyJwt, type JwtPayload } from '../../modules/auth/infrastructure/jwtMultiRole.js';
import type { UserRole } from '../../modules/auth/persistence/jwtUsersSchema.js';
import { throwApiError } from '../errors/apiError.js';

export interface AuthenticatedContext {
  tenantId: string;
  workspaceId: string | null;
  userId: string;
  roles: UserRole[];
}

export interface AuthenticateOptions {
  secret: string;
}

/** Resolve a JWT from Bearer auth or the browser auth cookie. */
export function authenticate(
  request: FastifyRequest,
  options: AuthenticateOptions,
): AuthenticatedContext {
  const token = bearerToken(request) ?? cookieMap(request)['__Host-lembar_session'];
  if (!token) throwApiError('missing_token', 'Authentication diperlukan');

  let payload: JwtPayload;
  try {
    payload = verifyJwt(token, options.secret);
  } catch {
    throwApiError('invalid_token', 'Token tidak valid atau expired');
  }

  return {
    tenantId: payload.workspaceId ?? payload.userId,
    workspaceId: payload.workspaceId,
    userId: payload.userId,
    roles: payload.roles,
  };
}

function bearerToken(request: FastifyRequest): string | null {
  const value = request.headers.authorization;
  if (!value) return null;
  const [scheme, token] = value.trim().split(/\s+/, 2);
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

function cookieMap(request: FastifyRequest): Record<string, string> {
  const raw = request.headers.cookie;
  if (!raw) return {};
  return Object.fromEntries(
    raw.split(';').map((part) => {
      const [name = '', ...value] = part.trim().split('=');
      return [name, value.join('=')];
    }),
  );
}
