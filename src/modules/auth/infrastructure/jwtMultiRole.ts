import jwt from 'jsonwebtoken';
import type { UserRole } from '../persistence/jwtUsersSchema.js';

export interface JwtPayload {
  userId: string;
  email: string;
  roles: UserRole[];
  workspaceId: string | null;
  iat: number;
  exp: number;
}

export interface JwtConfig {
  secret: string;
  expiryDays: number;
}

export function generateJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  config: JwtConfig,
): string {
  return jwt.sign(payload, config.secret, {
    algorithm: 'HS256',
    expiresIn: `${config.expiryDays}d`,
  });
}

export function verifyJwt(token: string, secret: string): JwtPayload {
  return jwt.verify(token, secret, { algorithms: ['HS256'] }) as JwtPayload;
}
