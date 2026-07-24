/**
 * B7-04 — School billing service.
 *
 * GET /v1/school/billing — seat count, plan tier, monthly usage.
 *
 * Per-seat billing model:
 * - seat count = number of active members in workspace
 * - plan tracked via WorkspacePlanRepository (B6-01)
 * - monthly usage = generationsUsedThisMonth
 */
import type { SchoolWorkspaceStore } from './SchoolService.js';
import type { WorkspacePlanRepository } from '../../plans/persistence/repository.js';
import { FREE_MONTHLY_LIMIT } from '../../plans/persistence/schema.js';
import type { BillingSnapshot } from '../domain/types.js';

export class SchoolBillingService {
  constructor(
    private readonly workspaceStore: SchoolWorkspaceStore,
    private readonly planRepo: WorkspacePlanRepository,
  ) {}

  /**
   * Get billing snapshot for a workspace.
   * Seat count = number of active members.
   */
  async getBillingSnapshot(tenantId: string, workspaceId: string): Promise<BillingSnapshot> {
    const [members, plan] = await Promise.all([
      this.workspaceStore.listMembers(tenantId, workspaceId),
      this.planRepo.findOrCreate(tenantId, workspaceId),
    ]);

    // Active seats only
    const activeMembers = members.filter((m) => m.state === 'active');
    const seatCount = activeMembers.length;

    return {
      workspaceId,
      plan: plan.plan,
      seatCount,
      generationsUsedThisMonth: plan.generationsUsedThisMonth,
      monthlyLimit: plan.plan === 'pro' ? null : FREE_MONTHLY_LIMIT,
      billingCycleStartedAt: plan.billingCycleStartedAt.toISOString(),
    };
  }
}
