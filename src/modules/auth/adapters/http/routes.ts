import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ApiError } from '../../../../common/errors/envelope.js';
import { REQUEST_ID_HEADER } from '../../../../common/middleware/request-id.js';
import { type AuthService } from '../../application/AuthService.js';
import { createAuthService } from '../../application/createAuthService.js';

const SESSION_COOKIE = '__Host-lembar_session';
const CSRF_COOKIE = 'lembar_csrf';
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3000'];

type StateChangingMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RegisterAuthRoutesOptions {
  auth?: AuthService;
  allowedOrigins?: string[];
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: RegisterAuthRoutesOptions = {},
): Promise<void> {
  const auth = options.auth ?? createAuthService();
  const allowedOrigins = new Set(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);

  app.addHook('preHandler', async (request) => {
    if (isStateChanging(request.method) && request.url.startsWith('/v1/auth/')) {
      enforceBrowserMutationProtection(request, allowedOrigins);
    }
  });

  app.post('/v1/auth/register', async (request, reply) => {
    const body = bodyOf<{ email: string; password: string }>(request);
    const result = await auth.register(body);
    if (result.status === 'created') {
      const login = await auth.login(body);
      setSessionCookies(reply, login.session.id, login.session.csrfToken);
    }
    return reply.status(result.status === 'created' ? 201 : 202).send({
      message: result.message,
      userId: result.userId,
      workspaceId: result.workspaceId,
    });
  });

  app.post('/v1/auth/login', async (request, reply) => {
    const body = bodyOf<{ email: string; password: string }>(request);
    const result = await auth.login(body);
    setSessionCookies(reply, result.session.id, result.session.csrfToken);
    return reply.status(200).send({ activeWorkspaceId: result.session.workspaceId });
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const sessionId = requireSessionCookie(request);
    await auth.logout({ sessionId });
    clearSessionCookies(reply);
    return reply.status(204).send();
  });

  app.post('/v1/auth/recovery/request', async (request, reply) => {
    const result = await auth.requestRecovery(bodyOf<{ email: string }>(request));
    return reply.status(202).send({ message: result.message });
  });

  app.post('/v1/auth/recovery/complete', async (request, reply) => {
    const result = await auth.completeRecovery(
      bodyOf<{ token: string; newPassword: string }>(request),
    );
    setSessionCookies(reply, result.session.id, result.session.csrfToken);
    return reply.status(200).send({ activeWorkspaceId: result.session.workspaceId });
  });

  app.post('/v1/auth/workspace/switch', async (request) => {
    const sessionId = requireSessionCookie(request);
    const result = await auth.switchWorkspace({
      sessionId,
      workspaceId: bodyOf<{ workspaceId: string }>(request).workspaceId,
    });
    return result;
  });

  app.post('/v1/auth/invitations/consume', async (request, reply) => {
    const body = bodyOf<{ token: string; password: string }>(request);
    const result = await auth.consumeSchoolInvitation(body);
    return reply.status(200).send(result);
  });

  app.get('/v1/me', async (request) => {
    return auth.currentContext(requireSessionCookie(request));
  });
}

function enforceBrowserMutationProtection(
  request: FastifyRequest,
  allowedOrigins: Set<string>,
): void {
  const origin = request.headers.origin;
  const csrf = request.headers['x-csrf-token'];
  const cookies = cookieMap(request);
  const validBootstrap = csrf === 'bootstrap' && !cookies[SESSION_COOKIE];
  const validSessionCsrf =
    typeof csrf === 'string' && csrf.length > 0 && csrf === cookies[CSRF_COOKIE];
  if (
    typeof origin !== 'string' ||
    !allowedOrigins.has(origin) ||
    (!validBootstrap && !validSessionCsrf)
  ) {
    throw new ApiError({
      code: 'PERMISSION_DENIED',
      message: 'Permintaan tidak diizinkan.',
      requestId: request.requestId ?? 'req_unknown',
      status: 403,
    });
  }
}

function isStateChanging(method: string): method is StateChangingMethod {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function requireSessionCookie(request: FastifyRequest): string {
  const value = cookieMap(request)[SESSION_COOKIE];
  if (!value) {
    throw new ApiError({
      code: 'AUTH_REQUIRED',
      message: 'Autentikasi diperlukan.',
      requestId: request.requestId ?? 'req_unknown',
      status: 401,
    });
  }
  return value;
}

function cookieMap(request: FastifyRequest): Record<string, string> {
  const raw = request.headers.cookie;
  if (!raw) return {};
  return Object.fromEntries(
    raw.split(';').map((chunk) => {
      const [name = '', ...value] = chunk.trim().split('=');
      return [name, value.join('=')];
    }),
  );
}

function setSessionCookies(reply: FastifyReply, sessionId: string, csrfToken: string): void {
  reply.header('set-cookie', [
    `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    `${CSRF_COOKIE}=${csrfToken}; Path=/; Secure; SameSite=Lax`,
  ]);
  reply.header(REQUEST_ID_HEADER, reply.request.requestId ?? 'req_unknown');
}

function clearSessionCookies(reply: FastifyReply): void {
  reply.header('set-cookie', [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `${CSRF_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`,
  ]);
}

function bodyOf<T>(request: FastifyRequest): T {
  return request.body as T;
}
