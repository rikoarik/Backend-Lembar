import type { FastifyInstance } from 'fastify';
import type { Database } from '../../../../infrastructure/database/db.js';
import { ApiError } from '../../../../common/errors/envelope.js';
import { createJwtAuthMiddleware } from '../../../../common/middleware/jwtMultiRoleAuth.js';
import type { AuthenticatedActor } from './routes.js';

const SOURCE_UPLOAD_PREFIX = '/v1/uploads/sources';
// BUG-19: `/v1/sources/*` needs the same JWT → actor resolution as the upload
// surface, otherwise the newly implemented intent/state routes would always
// see an unauthenticated request.
const SOURCE_PREFIX = '/v1/sources';

export async function registerUploadsAuthHook(
  app: FastifyInstance,
  options: { jwtSecret: string; db?: Database | undefined },
): Promise<void> {
  const authenticate = createJwtAuthMiddleware({ secret: options.jwtSecret, ...(options.db ? { db: options.db } : {}) });
  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    const covered =
      path.startsWith(SOURCE_UPLOAD_PREFIX) ||
      path === SOURCE_PREFIX ||
      path.startsWith(`${SOURCE_PREFIX}/`);
    if (!covered) return;
    if (request.method === 'GET' && request.url === '/v1/uploads/sources/health') return;
    await authenticate(request, reply);
    const user = request.jwtUser!;
    if (!user.workspaceId) {
      throw new ApiError({ code: 'WORKSPACE_ACCESS_DENIED', message: 'Workspace tidak ditemukan.', requestId: request.requestId ?? 'req_unknown', status: 403 });
    }
    const role = user.roles.find((candidate): candidate is AuthenticatedActor['role'] =>
      ['superadmin', 'school_admin', 'teacher', 'subscriber'].includes(candidate),
    );
    if (!role) {
      throw new ApiError({ code: 'PERMISSION_DENIED', message: 'Permintaan tidak diizinkan.', requestId: request.requestId ?? 'req_unknown', status: 403 });
    }
    request.actor = { userId: user.userId, role, workspaceId: user.workspaceId, tenantId: user.workspaceId };
  });
}
