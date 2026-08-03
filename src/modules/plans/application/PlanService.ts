/** Plan queries, quota checks, and transitions. */
import { FREE_MONTHLY_LIMIT } from '../persistence/schema.js';
import { WorkspacePlanRepository } from '../persistence/repository.js';
import type { WorkspacePlanSummary, PlanTransitionInput, EntitlementState } from '../domain/types.js';
import { QuotaExceededError } from '../domain/errors.js';
import { hashDeviceToken } from './TrialService.js';

interface TrialReader {
  findByWorkspace(workspaceId: string): Promise<{
    startsAt: Date;
    endsAt: Date;
    deviceHash: string;
  } | null>;
}

export class PlanService {
  constructor(
    private readonly repo: WorkspacePlanRepository,
    private readonly trials?: TrialReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getPlanSummary(
    tenantId: string,
    workspaceId: string,
    deviceToken?: string,
  ): Promise<WorkspacePlanSummary> {
    const plan = await this.repo.findOrCreate(tenantId, workspaceId);
    const trial = (await this.trials?.findByWorkspace(workspaceId)) ?? null;
    const current = this.now();
    const dateActive = Boolean(trial && trial.startsAt <= current && trial.endsAt > current);
    const deviceMatches = Boolean(
      dateActive && deviceToken && trial?.deviceHash === hashDeviceToken(deviceToken),
    );
    const paid = plan.plan === 'pro';
    const effectivePlan = paid || deviceMatches ? 'pro' : 'free';
    const remainingDays = trial
      ? Math.max(0, Math.ceil((trial.endsAt.getTime() - current.getTime()) / 86_400_000))
      : null;
    const quotaBlocked =
      !paid && !deviceMatches && plan.generationsUsedThisMonth >= FREE_MONTHLY_LIMIT;
    const trialExpired = Boolean(trial && !dateActive);
    const entitlementState: EntitlementState =
      paid || deviceMatches ? 'active'
      : quotaBlocked ? 'blocked'
      : trialExpired ? 'expired'
      : 'free';
    return {
      workspaceId,
      plan: effectivePlan,
      entitlementSource: paid ? 'paid' : deviceMatches ? 'trial' : 'free',
      entitlementState,
      generationsUsedThisMonth: plan.generationsUsedThisMonth,
      monthlyLimit: effectivePlan === 'pro' ? null : FREE_MONTHLY_LIMIT,
      billingCycleStartedAt: plan.billingCycleStartedAt.toISOString(),
      trial: {
        eligible: !paid && !trial,
        claimed: trial !== null,
        activeOnThisDevice: deviceMatches,
        startsAt: trial?.startsAt.toISOString() ?? null,
        endsAt: trial?.endsAt.toISOString() ?? null,
        remainingDays,
      },
    };
  }

  async assertQuota(tenantId: string, workspaceId: string, deviceToken?: string): Promise<void> {
    const plan = await this.repo.findOrCreate(tenantId, workspaceId);
    if (plan.plan === 'pro') return;
    const trial = await this.trials?.findByWorkspace(workspaceId);
    const current = this.now();
    if (
      trial &&
      trial.startsAt <= current &&
      trial.endsAt > current &&
      deviceToken &&
      trial.deviceHash === hashDeviceToken(deviceToken)
    )
      return;
    if (!(await this.repo.hasQuota(tenantId, workspaceId))) {
      throw new QuotaExceededError(workspaceId, plan.generationsUsedThisMonth, FREE_MONTHLY_LIMIT);
    }
  }

  async recordGeneration(
    tenantId: string,
    workspaceId: string,
    idempotencyKey?: string,
  ): Promise<void> {
    if (idempotencyKey && typeof this.repo.incrementUsageOnce === 'function') {
      await this.repo.incrementUsageOnce(tenantId, workspaceId, idempotencyKey);
      return;
    }
    await this.repo.incrementUsage(tenantId, workspaceId);
  }

  async setPlan(input: PlanTransitionInput): Promise<WorkspacePlanSummary> {
    const updated = await this.repo.setPlan(input.tenantId, input.workspaceId, input.newPlan);
    return {
      workspaceId: input.workspaceId,
      plan: updated.plan,
      entitlementSource: updated.plan === 'pro' ? 'paid' : 'free',
      entitlementState: updated.plan === 'pro' ? 'active' : 'free',
      generationsUsedThisMonth: updated.generationsUsedThisMonth,
      monthlyLimit: updated.plan === 'pro' ? null : FREE_MONTHLY_LIMIT,
      billingCycleStartedAt: updated.billingCycleStartedAt.toISOString(),
      trial: {
        eligible: updated.plan === 'free',
        claimed: false,
        activeOnThisDevice: false,
        startsAt: null,
        endsAt: null,
        remainingDays: null,
      },
    };
  }
}
