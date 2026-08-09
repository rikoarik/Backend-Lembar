/**
 * B7-02 — School admin dashboard routes.
 *
 * GET /v1/school/dashboard
 *   - school_admin role only (403 for others)
 *   - Query params: workspaceId (required), tenantId via x-tenant-id header
 *   - Returns: DashboardData { workspace, members, memberCount, usage }
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import type { SchoolDashboardService } from '../../application/SchoolDashboardService.js';
import { createJwtAuthMiddleware, requireRole } from '../../../../common/middleware/jwtMultiRoleAuth.js';
import type { Database } from '../../../../infrastructure/database/db.js';
import { throwApiError } from '../../../../common/errors/apiError.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'req_unknown';
}

export interface RegisterDashboardRoutesOptions {
  dashboardService: SchoolDashboardService;
  jwtSecret: string;
  db?: Database;
}

export async function registerDashboardRoutes(
  app: FastifyInstance,
  options: RegisterDashboardRoutesOptions,
): Promise<void> {
  const { dashboardService, jwtSecret, db } = options;
  const auth = createJwtAuthMiddleware({ secret: jwtSecret, db });

  /**
   * GET /v1/school/dashboard
   * Headers: x-tenant-id, x-user-role
   * Query:   workspaceId
   */
  app.get('/v1/school/dashboard', { preHandler: [auth, requireRole(['school_admin'])] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = request.jwtUser?.workspaceId;
    if (!workspaceId) throwApiError('forbidden', 'Akun tidak terhubung ke workspace sekolah');
    const data = await dashboardService.getDashboard(workspaceId, workspaceId);
    return reply.status(200).send({ data });
  });
}
