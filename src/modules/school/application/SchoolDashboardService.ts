/**
 * B7-02 — School admin dashboard service.
 *
 * GET /v1/school/dashboard — members, usage, billing.
 * school_admin only.
 */
import type { SchoolWorkspaceStore } from './SchoolService.js';
import type { SchoolMember } from '../domain/types.js';
import type { WorkspacePlanRepository } from '../../plans/persistence/repository.js';
import { FREE_MONTHLY_LIMIT } from '../../plans/persistence/schema.js';

export interface DashboardData {
  workspace: {
    id: string;
    name: string;
    level: string;
    tenantId: string;
  };
  members: SchoolMember[];
  memberCount: number;
  usage: {
    generationsUsedThisMonth: number;
    monthlyLimit: number | null;
    plan: 'free' | 'pro';
  };
}

export class SchoolDashboardService {
  constructor(
    private readonly workspaceStore: SchoolWorkspaceStore,
    private readonly planRepo: WorkspacePlanRepository,
  ) {}

  async getDashboard(tenantId: string, workspaceId: string): Promise<DashboardData> {
    const [workspace, members, plan] = await Promise.all([
      this.workspaceStore.getWorkspace(tenantId, workspaceId),
      this.workspaceStore.listMembers(tenantId, workspaceId),
      this.planRepo.findOrCreate(tenantId, workspaceId),
    ]);

    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        level: workspace.level,
        tenantId: workspace.tenantId,
      },
      members,
      memberCount: members.length,
      usage: {
        generationsUsedThisMonth: plan.generationsUsedThisMonth,
        monthlyLimit: plan.plan === 'pro' ? null : FREE_MONTHLY_LIMIT,
        plan: plan.plan,
      },
    };
  }
}
