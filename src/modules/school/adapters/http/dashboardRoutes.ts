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

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'req_unknown';
}

export interface RegisterDashboardRoutesOptions {
  dashboardService: SchoolDashboardService;
}

export async function registerDashboardRoutes(
  app: FastifyInstance,
  options: RegisterDashboardRoutesOptions,
): Promise<void> {
  const { dashboardService } = options;

  /**
   * GET /v1/school/dashboard
   * Headers: x-tenant-id, x-user-role
   * Query:   workspaceId
   */
  app.get('/v1/school/dashboard', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = (request.headers['x-tenant-id'] as string | undefined) ?? '';
    const userRole = (request.headers['x-user-role'] as string | undefined) ?? '';
    const { workspaceId } = request.query as { workspaceId?: string };
    const requestId = getRequestId(request);

    // Validasi kehadiran x-tenant-id
    if (!tenantId) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Missing x-tenant-id header',
          requestId,
          retryable: false,
        },
      });
    }

    // Hanya school_admin yang boleh akses dashboard
    if (userRole !== 'school_admin') {
      return reply.status(403).send({
        error: {
          code: 'PERMISSION_DENIED',
          message: 'Dashboard requires school_admin role',
          requestId,
          retryable: false,
        },
      });
    }

    // workspaceId wajib ada
    if (!workspaceId) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Missing workspaceId query parameter',
          requestId,
          retryable: false,
        },
      });
    }

    const data = await dashboardService.getDashboard(tenantId, workspaceId);
    return reply.status(200).send({ data });
  });
}
