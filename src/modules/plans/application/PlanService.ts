/**
 * Plan application service (B6-01).
 *
 * Orchestrates plan queries, quota checks, and plan transitions.
 */
import { FREE_MONTHLY_LIMIT, type PlanType } from '../persistence/schema.js';
import { WorkspacePlanRepository } from '../persistence/repository.js';
import type { WorkspacePlanSummary, PlanTransitionInput } from '../domain/types.js';
import { QuotaExceededError } from '../domain/errors.js';

export class PlanService {
  constructor(private readonly repo: WorkspacePlanRepository) {}

  async getPlanSummary(tenantId: string, workspaceId: string): Promise<WorkspacePlanSummary> {
    const plan = await this.repo.findOrCreate(tenantId, workspaceId);
    return {
      workspaceId,
      plan: plan.plan,
      generationsUsedThisMonth: plan.generationsUsedThisMonth,
      monthlyLimit: plan.plan === 'pro' ? null : FREE_MONTHLY_LIMIT,
      billingCycleStartedAt: plan.billingCycleStartedAt.toISOString(),
    };
  }

  /**
   * Check quota before a generation. Throws QuotaExceededError if over limit.
   */
  async assertQuota(tenantId: string, workspaceId: string): Promise<void> {
    const ok = await this.repo.hasQuota(tenantId, workspaceId);
    if (!ok) {
      const plan = await this.repo.findOrCreate(tenantId, workspaceId);
      throw new QuotaExceededError(
        workspaceId,
        plan.generationsUsedThisMonth,
        FREE_MONTHLY_LIMIT,
      );
    }
  }

  /**
   * Atomically increment usage after a successful generation.
   */
  async recordGeneration(tenantId: string, workspaceId: string): Promise<void> {
    await this.repo.incrementUsage(tenantId, workspaceId);
  }

  /**
   * Transition a workspace to a new plan (admin operation).
   */
  async setPlan(input: PlanTransitionInput): Promise<WorkspacePlanSummary> {
    const updated = await this.repo.setPlan(input.tenantId, input.workspaceId, input.newPlan);
    return {
      workspaceId: input.workspaceId,
      plan: updated.plan,
      generationsUsedThisMonth: updated.generationsUsedThisMonth,
      monthlyLimit: updated.plan === 'pro' ? null : FREE_MONTHLY_LIMIT,
      billingCycleStartedAt: updated.billingCycleStartedAt.toISOString(),
    };
  }
}
