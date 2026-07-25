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
}

export async function registerStatsRoutes(
  app: FastifyInstance,
  options: RegisterStatsRoutesOptions,
): Promise<void> {
  const { workspaceStore, planRepo } = options;

  /**
   * GET /v1/school/stats
   * Headers: x-tenant-id, x-user-role
   * Query:   workspaceId
   * Returns: { data: StatsData }
   */
  app.get('/v1/school/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = getRequestId(request);
    const tenantId = (request.headers['x-tenant-id'] as string | undefined) ?? '';
    const userRole = (request.headers['x-user-role'] as string | undefined) ?? '';
    const { workspaceId } = request.query as { workspaceId?: string };

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

    if (userRole !== 'school_admin') {
      return reply.status(403).send({
        error: {
          code: 'PERMISSION_DENIED',
          message: 'This endpoint requires school_admin role',
          requestId,
          retryable: false,
        },
      });
    }

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
