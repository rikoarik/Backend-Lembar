import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import type { Database } from '../../../../infrastructure/database/db.js';
import { createJwtAuthMiddleware } from '../../../../common/middleware/jwtMultiRoleAuth.js';
import { throwApiError } from '../../../../common/errors/apiError.js';

export interface AssessmentRouteAuthOptions {
  jwtSecret: string;
  db?: Database | undefined;
}

export function assessmentPrivateAuth(options: AssessmentRouteAuthOptions): preHandlerHookHandler[] {
  return [
    createJwtAuthMiddleware({ secret: options.jwtSecret, ...(options.db ? { db: options.db } : {}) }),
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const workspaceId = request.jwtUser?.workspaceId;
      if (!workspaceId) throwApiError('forbidden', 'Akun tidak terhubung ke workspace');
      const pathWorkspaceId = (request.params as { workspaceId?: string }).workspaceId;
      if (pathWorkspaceId && pathWorkspaceId !== workspaceId) {
        throwApiError('forbidden', 'Workspace path tidak sesuai dengan token');
      }
    },
  ];
}

export function jwtWorkspace(request: FastifyRequest): string {
  return request.jwtUser!.workspaceId!;
}

export function jwtActor(request: FastifyRequest): string {
  return request.jwtUser!.userId;
}
