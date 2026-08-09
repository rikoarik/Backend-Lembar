/**
 * B7-06 — School stats route.
 *
 * GET /v1/school/stats
 *   - school_admin role only
 *   - Returns aggregate KPI data for the school admin panel:
 *     totalMembers, activeMembers, teacherCount, adminCount,
 *     plan, generationsUsedThisMonth, monthlyLimit, workspaceName
 *
 * Headers: x-tenant-id, x-user-role
 * Query:   workspaceId (required)
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import type { SchoolWorkspaceStore } from '../../application/SchoolService.js';
import type { WorkspacePlanRepository } from '../../../plans/persistence/repository.js';
import { FREE_MONTHLY_LIMIT } from '../../../plans/persistence/schema.js';
import { createJwtAuthMiddleware, requireRole } from '../../../../common/middleware/jwtMultiRoleAuth.js';
import type { Database } from '../../../../infrastructure/database/db.js';
import { throwApiError } from '../../../../common/errors/apiError.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'req_unknown';
}

export interface StatsData {
  workspaceName: string;
  totalMembers: number;
  activeMembers: number;
  teacherCount: number;
  adminCount: number;
  plan: 'free' | 'pro';
  generationsUsedThisMonth: number;
  monthlyLimit: number | null;
}

export interface RegisterStatsRoutesOptions {
  workspaceStore: SchoolWorkspaceStore;
  planRepo: WorkspacePlanRepository;
  jwtSecret: string;
  db?: Database;
}

export async function registerStatsRoutes(
  app: FastifyInstance,
  options: RegisterStatsRoutesOptions,
): Promise<void> {
  const { workspaceStore, planRepo, jwtSecret, db } = options;
  const auth = createJwtAuthMiddleware({ secret: jwtSecret, db });

  /**
   * GET /v1/school/stats
   * Headers: x-tenant-id, x-user-role
   * Query:   workspaceId
   * Returns: { data: StatsData }
   */
  app.get('/v1/school/stats', { preHandler: [auth, requireRole(['school_admin'])] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = getRequestId(request);
    const workspaceId = request.jwtUser?.workspaceId;
    if (!workspaceId) throwApiError('forbidden', 'Akun tidak terhubung ke workspace sekolah');
    const tenantId = workspaceId;

    const [workspace, members, plan] = await Promise.all([
      workspaceStore.getWorkspace(tenantId, workspaceId),
      workspaceStore.listMembers(tenantId, workspaceId),
      planRepo.findOrCreate(tenantId, workspaceId),
    ]);

    if (!workspace) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: `Workspace ${workspaceId} not found`,
          requestId,
          retryable: false,
        },
      });
    }

    const activeMembers = members.filter((m) => m.state === 'active');
    const teacherCount = activeMembers.filter((m) => m.role === 'teacher').length;
    const adminCount = activeMembers.filter((m) => m.role === 'school_admin').length;

    const stats: StatsData = {
      workspaceName: workspace.name,
      totalMembers: members.length,
      activeMembers: activeMembers.length,
      teacherCount,
      adminCount,
      plan: plan.plan,
      generationsUsedThisMonth: plan.generationsUsedThisMonth,
      monthlyLimit: plan.plan === 'pro' ? null : FREE_MONTHLY_LIMIT,
    };

    return reply.status(200).send({ data: stats });
  });
}
