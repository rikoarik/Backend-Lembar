/** Plan queries, quota checks, and transitions. */
import { FREE_MONTHLY_LIMIT, FREE_MONTHLY_TOKEN_LIMIT } from '../persistence/schema.js';
import { WorkspacePlanRepository } from '../persistence/repository.js';
import type {
  WorkspacePlanSummary,
  PlanTransitionInput,
  EntitlementState,
} from '../domain/types.js';
import { QuotaExceededError } from '../domain/errors.js';
import { hashDeviceToken } from './TrialService.js';
import type { PlanCatalogRepository, PlanCatalogEntry } from '../persistence/catalogRepository.js';

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
    private readonly catalog?: Pick<PlanCatalogRepository, 'find'>,
  ) {}

  private async catalogFor(key: 'free' | 'pro'): Promise<PlanCatalogEntry> {
    const found = await this.catalog?.find(key);
    if (found) return found;
    // ponytail: fail-safe for tests/no DB; remove once migration 0030 is mandatory everywhere.
    return {
      key,
      displayName: key === 'pro' ? 'Pro' : 'Free',
      priceAmount: key === 'pro' ? 49_000 : 0,
      currency: 'IDR',
      billingPeriod: key === 'pro' ? 'monthly' : null,
      tokenMonthlyLimit: key === 'pro' ? null : FREE_MONTHLY_TOKEN_LIMIT,
      features: [],
      active: true,
      revision: 1,
      updatedAt: new Date(0).toISOString(),
      updatedBy: null,
    };
  }

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
    const catalog = await this.catalogFor(effectivePlan);
    const remainingDays = trial
      ? Math.max(0, Math.ceil((trial.endsAt.getTime() - current.getTime()) / 86_400_000))
      : null;
    const quotaBlocked =
      !paid &&
      !deviceMatches &&
      (plan.tokensUsedThisMonth ?? 0) >= (catalog.tokenMonthlyLimit ?? FREE_MONTHLY_TOKEN_LIMIT);
    const trialExpired = Boolean(trial && !dateActive);
    const entitlementState: EntitlementState =
      paid || deviceMatches
        ? 'active'
        : quotaBlocked
          ? 'blocked'
          : trialExpired
            ? 'expired'
            : 'free';
    return {
      workspaceId,
      plan: effectivePlan,
      entitlementSource: paid ? 'paid' : deviceMatches ? 'trial' : 'free',
      entitlementState,
      generationsUsedThisMonth: plan.generationsUsedThisMonth,
      monthlyLimit: effectivePlan === 'pro' ? null : FREE_MONTHLY_LIMIT,
      tokenUsedThisMonth: plan.tokensUsedThisMonth ?? 0,
      tokenMonthlyLimit: effectivePlan === 'pro' ? null : catalog.tokenMonthlyLimit,
      billingCycleStartedAt: plan.billingCycleStartedAt.toISOString(),
      catalog: {
        key: catalog.key,
        displayName: catalog.displayName,
        priceAmount: catalog.priceAmount,
        currency: catalog.currency,
        billingPeriod: catalog.billingPeriod,
        tokenMonthlyLimit: catalog.tokenMonthlyLimit,
        features: catalog.features,
      },
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
    const catalog = await this.catalogFor('free');
    if (
      (plan.tokensUsedThisMonth ?? 0) >= (catalog.tokenMonthlyLimit ?? FREE_MONTHLY_TOKEN_LIMIT)
    ) {
      throw new QuotaExceededError(
        workspaceId,
        plan.tokensUsedThisMonth ?? 0,
        catalog.tokenMonthlyLimit ?? FREE_MONTHLY_TOKEN_LIMIT,
      );
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
    const catalog = await this.catalogFor(updated.plan);
    return {
      workspaceId: input.workspaceId,
      plan: updated.plan,
      entitlementSource: updated.plan === 'pro' ? 'paid' : 'free',
      entitlementState: updated.plan === 'pro' ? 'active' : 'free',
      generationsUsedThisMonth: updated.generationsUsedThisMonth,
      monthlyLimit: updated.plan === 'pro' ? null : FREE_MONTHLY_LIMIT,
      tokenUsedThisMonth: updated.tokensUsedThisMonth ?? 0,
      tokenMonthlyLimit: catalog.tokenMonthlyLimit,
      billingCycleStartedAt: updated.billingCycleStartedAt.toISOString(),
      catalog: {
        key: catalog.key,
        displayName: catalog.displayName,
        priceAmount: catalog.priceAmount,
        currency: catalog.currency,
        billingPeriod: catalog.billingPeriod,
        tokenMonthlyLimit: catalog.tokenMonthlyLimit,
        features: catalog.features,
      },
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
