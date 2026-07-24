/**
 * Google OAuth 2.0 strategy for Lembar.
 * 
 * Flow:
 * 1. FE redirects to Google consent screen
 * 2. Google redirects back with code
 * 3. BE exchanges code for Google tokens
 * 4. BE verifies Google ID token, extracts email
 * 5. BE creates/updates jwt_users, issues JWT
 * 
 * Required env vars:
 * - GOOGLE_CLIENT_ID
 * - GOOGLE_CLIENT_SECRET
 * - GOOGLE_REDIRECT_URI (e.g., https://app.lembar.web.id/auth/callback)
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { ApiError } from '../../../../common/errors/envelope.js';
import { generateJwt } from '../../infrastructure/jwtMultiRole.js';
import type { Database } from '../../../../infrastructure/database/db.js';
import { tenants } from '../../../../infrastructure/database/schema.js';
import { hashPassword } from '../../infrastructure/password.js';
import { jwtUsers, type UserRole } from '../../persistence/jwtUsersSchema.js';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  jwtSecret: string;
  jwtExpiryDays: number;
}

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
}

export interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
}

function getRequestId(req: FastifyRequest): string {
  return req.requestId ?? 'req_unknown';
}

/**
 * Exchange authorization code for Google tokens.
 */
async function exchangeCodeForTokens(
  code: string,
  config: GoogleOAuthConfig,
): Promise<GoogleTokens> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token exchange failed: ${response.status} ${text}`);
  }

  return response.json() as Promise<GoogleTokens>;
}

/**
 * Fetch user info from Google using access token.
 */
async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Google user info: ${response.status}`);
  }

  return response.json() as Promise<GoogleUserInfo>;
}

/**
 * Find or create user in jwt_users table.
 * New Google users are auto-registered as subscriber with a personal tenant.
 */
async function findOrCreateUser(
  db: Database,
  googleUser: GoogleUserInfo,
): Promise<{ id: string; email: string; name: string; roles: UserRole[]; workspaceId: string | null }> {
  // Check if user exists
  const existing = await db
    .select()
    .from(jwtUsers)
    .where(eq(jwtUsers.email, googleUser.email))
    .limit(1);

  if (existing[0]) {
    return {
      id: existing[0].id,
      email: existing[0].email,
      name: existing[0].name,
      roles: existing[0].roles,
      workspaceId: existing[0].workspaceId,
    };
  }

  // Create tenant first — jwt_users.workspace_id FK references tenants.id
  const userName = (googleUser.name ?? googleUser.email.split('@')[0] ?? 'User').trim() || 'User';
  const slugBase = googleUser.email
    .split('@')[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'user';
  const workspaceSlug = `${slugBase}-${randomUUID().slice(0, 8)}`;

  const [workspace] = await db
    .insert(tenants)
    .values({
      slug: workspaceSlug,
      name: `${userName}'s Workspace`,
    })
    .returning();

  if (!workspace) {
    throw new Error('Gagal membuat workspace untuk user Google');
  }

  // OAuth users have no password login — store a random unusable hash.
  const passwordHash = await hashPassword(randomUUID());

  const [newUser] = await db
    .insert(jwtUsers)
    .values({
      email: googleUser.email,
      passwordHash,
      name: userName,
      roles: ['subscriber'] as UserRole[],
      workspaceId: workspace.id,
    })
    .returning();

  if (!newUser) {
    throw new Error('Gagal membuat user Google');
  }

  return {
    id: newUser.id,
    email: newUser.email,
    name: newUser.name,
    roles: newUser.roles,
    workspaceId: newUser.workspaceId,
  };
}

export interface RegisterGoogleOAuthRoutesOptions {
  db: Database;
  config: GoogleOAuthConfig;
}

/**
 * Register Google OAuth routes.
 * 
 * POST /v1/auth/google/callback — exchange code, issue JWT
 * GET /v1/auth/google/url — get Google OAuth URL for FE redirect
 */
export async function registerGoogleOAuthRoutes(
  app: FastifyInstance,
  options: RegisterGoogleOAuthRoutesOptions,
): Promise<void> {
  const { db, config } = options;

  /**
   * GET /v1/auth/google/url
   * Returns the Google OAuth consent URL for frontend to redirect.
   */
  app.get('/v1/auth/google/url', async (request: FastifyRequest, reply: FastifyReply) => {
    const state = randomUUID(); // Should be stored and validated in production
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    return reply.status(200).send({ url, state });
  });

  /**
   * POST /v1/auth/google/callback
   * Body: { code: string, state?: string }
   * Returns: { token, user }
   */
  app.post('/v1/auth/google/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { code?: string; state?: string } | null | undefined;
    const code = body?.code;
    const requestId = getRequestId(request);

    if (!code) {
      throw new ApiError({
        code: 'VALIDATION_FAILED',
        message: 'Authorization code diperlukan.',
        requestId,
        status: 400,
      });
    }

    try {
      // Exchange code for tokens
      const tokens = await exchangeCodeForTokens(code, config);

      // Fetch user info from Google
      const googleUser = await fetchGoogleUserInfo(tokens.access_token);

      if (!googleUser.email_verified) {
        throw new ApiError({
          code: 'VALIDATION_FAILED',
          message: 'Email Google belum diverifikasi.',
          requestId,
          status: 400,
        });
      }

      // Find or create user in DB
      const user = await findOrCreateUser(db, googleUser);

      // Issue JWT
      const token = generateJwt(
        {
          userId: user.id,
          email: user.email,
          roles: user.roles,
          workspaceId: user.workspaceId,
        },
        { secret: config.jwtSecret, expiryDays: config.jwtExpiryDays },
      );

      return reply.status(200).send({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: googleUser.name ?? null,
          roles: user.roles,
          workspaceId: user.workspaceId,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw new ApiError({
        code: 'AUTH_REQUIRED',
        message: `Autentikasi Google gagal: ${message}`,
        requestId,
        status: 401,
      });
    }
  });
}
