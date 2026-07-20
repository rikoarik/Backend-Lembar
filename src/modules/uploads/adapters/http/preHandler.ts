/**
 * B2-01 — Minimal authentication preHandler hook.
 *
 * The B2-01 contract forbids changing existing modules. This hook installs
 * an `actor` onto each request that has the right credentials, using only
 * new files. Tests can also inject `actor` directly on `request` via the
 * route handler to bypass it; production builds wire the integration when
 * the auth module exposes a stable membership middleware, which is deferred
 * to B2-05.
 *
 * For B2-01 we deliberately keep it scoped to the new module and route
 * prefix. Other modules continue to use their own auth paths.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ApiError } from '../../../../common/errors/envelope.js';
import { type AuthenticatedActor } from './routes.js';

const SOURCE_UPLOAD_PREFIX = '/v1/uploads/sources';

export async function registerUploadsAuthHook(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request) => {
    if (!isSourceUploadPath(request.url)) return;
    if (request.method === 'GET' && request.url === '/v1/uploads/sources/health') return;
    const actor = parseActorFromHeaders(request);
    if (!actor) {
      throw new ApiError({
        code: 'AUTH_REQUIRED',
        message: 'Autentikasi diperlukan.',
        requestId: request.requestId ?? 'req_unknown',
        status: 401,
      });
    }
    (request as unknown as { actor?: AuthenticatedActor }).actor = actor;
  });
}

function isSourceUploadPath(url: string): boolean {
  return url.startsWith(SOURCE_UPLOAD_PREFIX);
}

function parseActorFromHeaders(request: FastifyRequest): AuthenticatedActor | null {
  const userId = headerString(request, 'x-source-user-id');
  const role = headerString(request, 'x-source-role');
  const workspaceId = headerString(request, 'x-workspace-id');
  const tenantId = headerString(request, 'x-tenant-id');
  if (!userId || !role || !workspaceId || !tenantId) return null;
  if (!['superadmin', 'school_admin', 'teacher', 'subscriber'].includes(role)) return null;
  return { userId, role: role as AuthenticatedActor['role'], workspaceId, tenantId };
}

function headerString(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name];
  if (typeof raw !== 'string') return null;
  return raw.length === 0 ? null : raw;
}
