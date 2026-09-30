import jwt from 'jsonwebtoken';
import type { UserRole } from '../persistence/jwtUsersSchema.js';

export interface JwtPayload {
  userId: string;
  email: string;
  roles: UserRole[];
  workspaceId: string | null;
  /**
   * BUG-21: `jwt_users.session_version` at mint time. The auth middleware
   * rejects a token whose `sv` no longer matches the stored column, which is
   * how `POST /v1/auth/logout` invalidates tokens that were already issued —
   * a stateless JWT cannot be un-signed.
   */
  sv: number;
  iat: number;
  exp: number;
}

export interface JwtConfig {
  secret: string;
  expiryDays: number;
}

export type JwtSignInput = Omit<JwtPayload, 'iat' | 'exp' | 'sv'> & { sv?: number };

/**
 * Tokens minted before the `sv` claim existed are read as version 1, matching
 * the `jwt_users.session_version` column default, so deploying this change does
 * not log everyone out — only an actual logout does.
 */
export const DEFAULT_SESSION_VERSION = 1;

export function generateJwt(payload: JwtSignInput, config: JwtConfig): string {
  const claims: Omit<JwtPayload, 'iat' | 'exp'> = {
    ...payload,
    sv: payload.sv ?? DEFAULT_SESSION_VERSION,
  };
  return jwt.sign(claims, config.secret, {
    algorithm: 'HS256',
    expiresIn: `${config.expiryDays}d`,
  });
}

export function verifyJwt(token: string, secret: string): JwtPayload {
  const legacySecret = process.env['JWT_SECRET_LEGACY']?.trim();
  let decoded: JwtPayload;
  try {
    decoded = jwt.verify(token, secret, { algorithms: ['HS256'] }) as JwtPayload;
  } catch (error) {
    if (!legacySecret || legacySecret === secret) throw error;
    decoded = jwt.verify(token, legacySecret, { algorithms: ['HS256'] }) as JwtPayload;
  }
  return { ...decoded, sv: normalizeSessionVersion(decoded.sv) };
}

function normalizeSessionVersion(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_SESSION_VERSION;
}
