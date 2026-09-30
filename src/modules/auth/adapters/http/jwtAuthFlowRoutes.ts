/**
 * JWT-mode auth routes that the FE actually calls but which were never
 * registered (BUG-18 / BUG-21 / BUG-22, FE-AUD-01-2026-09-30).
 *
 * `registerAuthRoutes` (the session-cookie family) is intentionally disabled in
 * `src/bootstrap/app.ts`; this module provides the same *paths* on top of the
 * JWT identity model so the BFF can stop 404-ing. All of it is additive — no
 * existing route is replaced.
 *
 *   POST /v1/auth/logout                 revoke every JWT of the caller
 *   POST /v1/auth/recovery/request       neutral recovery request (BUG-18)
 *   POST /v1/auth/recovery/complete      finish recovery after the link
 *   POST /v1/auth/workspace/switch       move the caller to another workspace
 *   GET  /v1/auth/invitations/preview    read an invitation before accepting
 *   POST /v1/auth/invitations/consume    OFFICIAL accept contract
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { throwApiError } from '../../../../common/errors/apiError.js';
import {
  createJwtAuthMiddleware,
  type JwtAuthMiddlewareOptions,
} from '../../../../common/middleware/jwtMultiRoleAuth.js';
import { rateLimit, verifyTurnstile } from '../../../../common/security/rateLimit.js';
import type { Database } from '../../../../infrastructure/database/db.js';
import { JwtMultiRoleAuthService } from '../../application/JwtMultiRoleAuthService.js';
import { AuthRecoveryService, InvitationService } from '../../application/JwtAuthFlows.js';
import { PasswordResetService } from '../../application/PasswordResetService.js';

export interface RegisterJwtAuthFlowRoutesOptions {
  db: Database;
  jwtSecret: string;
  jwtExpiryDays: number;
  /** Base URL used to build the recovery link handed to the notification adapter. */
  appUrl?: string;
}

const DEFAULT_APP_URL = 'http://localhost:3000';

export async function registerJwtAuthFlowRoutes(
  app: FastifyInstance,
  options: RegisterJwtAuthFlowRoutesOptions,
): Promise<void> {
  const authService = new JwtMultiRoleAuthService(options.db, {
    secret: options.jwtSecret,
    expiryDays: options.jwtExpiryDays,
  });
  const authMiddlewareOptions: JwtAuthMiddlewareOptions = {
    secret: options.jwtSecret,
    db: options.db,
  };
  const auth = createJwtAuthMiddleware(authMiddlewareOptions);
  const recovery = new AuthRecoveryService(options.db, {
    appUrl: options.appUrl ?? DEFAULT_APP_URL,
    jwtSecret: options.jwtSecret,
    jwtExpiryDays: options.jwtExpiryDays,
  });
  const passwordReset = new PasswordResetService(options.db);
  const invitations = new InvitationService(options.db, {
    jwtSecret: options.jwtSecret,
    jwtExpiryDays: options.jwtExpiryDays,
  });

  // ── POST /v1/auth/logout ───────────────────────────────────────────────────
  // A missing bearer token means "already logged out": answering 200 instead of
  // 401 keeps the BFF's best-effort call silent when the cookie is gone.
  app.post('/v1/auth/logout', async (request, reply) => {
    const token = extractBearerToken(request);
    if (!token) {
      return reply.status(200).send({ data: { loggedOut: true } });
    }

    try {
      const user = await authService.getCurrentUser(token);
      await recovery.revokeAllSessions(user.id);
    } catch {
      // An expired or already-revoked token is still "logged out".
    }
    return reply.status(200).send({ data: { loggedOut: true } });
  });

  // ── POST /v1/auth/recovery/request ─────────────────────────────────────────
  // Always 202 with the same message, whether or not the address is registered.
  app.post('/v1/auth/recovery/request', async (request, reply) => {
    const body = request.body as
      | { email?: unknown; identifier?: unknown; captchaToken?: unknown }
      | null;
    rateLimit(request, reply, 'recovery-request', 10, 15 * 60 * 1000);
    await verifyTurnstile(request, body?.captchaToken);

    const raw =
      typeof body?.email === 'string'
        ? body.email
        : typeof body?.identifier === 'string'
          ? body.identifier
          : '';
    const result = await recovery.requestRecovery(raw);
    return reply.status(202).send({ message: result.message });
  });

  // ── POST /v1/auth/recovery/complete ────────────────────────────────────────
  // Recovery runs through `password_resets` — the same store as the
  // superadmin-issued flow — so the recovery link and `/v1/auth/reset-password`
  // are interchangeable.
  app.post('/v1/auth/recovery/complete', async (request, reply) => {
    const body = request.body as
      | { token?: unknown; newPassword?: unknown; password?: unknown }
      | null;
    rateLimit(request, reply, 'recovery-complete', 10, 15 * 60 * 1000);
    const token = typeof body?.token === 'string' ? body.token : '';
    const newPassword =
      typeof body?.newPassword === 'string'
        ? body.newPassword
        : typeof body?.password === 'string'
          ? body.password
          : '';
    if (!token || !newPassword) {
      throwApiError('missing_fields', 'token dan newPassword diperlukan');
    }

    const userId = await passwordReset.applyAndReturnUser(token, newPassword);
    return reply.status(200).send({ data: { reset: true, userId } });
  });

  // ── POST /v1/auth/workspace/switch ─────────────────────────────────────────
  app.post('/v1/auth/workspace/switch', { preHandler: auth }, async (request, reply) => {
    const body = request.body as { workspaceId?: unknown } | null;
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId.trim() : '';
    if (!workspaceId || workspaceId.length > 128) {
      throwApiError('invalid_input', 'Workspace tidak valid.');
    }
    const result = await recovery.switchWorkspace(request.jwtUser!.userId, workspaceId);
    return reply.status(200).send({ data: result });
  });

  // ── GET /v1/auth/invitations/preview ───────────────────────────────────────
  // Public: the invited person has no account yet. The response never exposes
  // the invited email or the raw token — only whether the token is usable.
  app.get('/v1/auth/invitations/preview', async (request, reply) => {
    rateLimit(request, reply, 'invitation-preview', 30, 15 * 60 * 1000);
    const preview = await invitations.preview(readToken(request));
    return reply.status(200).send({ data: preview });
  });

  // ── POST /v1/auth/invitations/consume ──────────────────────────────────────
  // OFFICIAL accept contract. Supersedes the older `POST /v1/invitations/accept`,
  // which demanded a JWT a brand-new invitee cannot have.
  app.post('/v1/auth/invitations/consume', async (request, reply) => {
    const body = request.body as
      | { token?: unknown; password?: unknown; dryRun?: unknown }
      | null;
    rateLimit(request, reply, 'invitation-consume', 20, 15 * 60 * 1000);
    const token = readToken(request);
    if (!token) throwApiError('missing_fields', 'token diperlukan');

    if (body?.dryRun === true) {
      const preview = await invitations.preview(token);
      return reply.status(200).send({ data: preview });
    }

    const password = typeof body?.password === 'string' ? body.password : '';
    if (!password) throwApiError('missing_fields', 'password diperlukan');

    const result = await invitations.consume(token, password);
    return reply.status(200).send({ data: result });
  });
}

/** Accepts the invitation token from the query string (preview) or the body. */
function readToken(request: FastifyRequest): string {
  const query = request.query as { token?: unknown } | undefined;
  if (typeof query?.token === 'string' && query.token) return query.token;
  const body = request.body as { token?: unknown } | undefined;
  return typeof body?.token === 'string' ? body.token : '';
}

function extractBearerToken(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (!auth) return null;
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1] || null;
}
