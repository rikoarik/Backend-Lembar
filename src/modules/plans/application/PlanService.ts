/** Plan queries, quota checks, and transitions. */
import {
  FREE_MONTHLY_LIMIT,
  FREE_MONTHLY_TOKEN_LIMIT,
  PRO_MONTHLY_TOKEN_LIMIT,
  PLUS_MONTHLY_TOKEN_LIMIT,
} from '../persistence/schema.js';
import type { PlanType } from '../persistence/schema.js';
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

  private async catalogFor(key: PlanType): Promise<PlanCatalogEntry> {
    const found = await this.catalog?.find(key);
    if (found) return found;
    // ponytail: fail-safe for tests/no DB; remove once migration 0034 is mandatory everywhere.
    // Every tier is finite — the product never promises unlimited AI.
    const tokenMonthlyLimit =
      key === 'plus'
        ? PLUS_MONTHLY_TOKEN_LIMIT
        : key === 'pro'
          ? PRO_MONTHLY_TOKEN_LIMIT
          : FREE_MONTHLY_TOKEN_LIMIT;
    const priceAmount = key === 'plus' ? 149_000 : key === 'pro' ? 49_000 : 0;
    return {
      key,
      displayName: key === 'plus' ? 'Plus' : key === 'pro' ? 'Pro' : 'Free',
      priceAmount,
      currency: 'IDR',
      billingPeriod: key === 'free' ? null : 'monthly',
      tokenMonthlyLimit,
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
    const paid = plan.plan === 'pro' || plan.plan === 'plus';
    const effectivePlan: PlanType = plan.plan !== 'free' ? plan.plan : deviceMatches ? 'pro' : 'free';
    const catalog = await this.catalogFor(effectivePlan);
    const remainingDays = trial
      ? Math.max(0, Math.ceil((trial.endsAt.getTime() - current.getTime()) / 86_400_000))
      : null;
    // Every tier is finite — quota blocking applies to paid plans too.
    const tokenMonthlyLimit = catalog.tokenMonthlyLimit ?? FREE_MONTHLY_TOKEN_LIMIT;
    const quotaBlocked =
      !paid &&
      !deviceMatches &&
      (plan.tokensUsedThisMonth ?? 0) >= tokenMonthlyLimit;
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
      monthlyLimit: effectivePlan === 'free' ? FREE_MONTHLY_LIMIT : null,
      tokenUsedThisMonth: plan.tokensUsedThisMonth ?? 0,
      tokenMonthlyLimit,
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
    const trial = await this.trials?.findByWorkspace(workspaceId);
    const current = this.now();
    const trialActive = Boolean(
      trial &&
        trial.startsAt <= current &&
        trial.endsAt > current &&
        deviceToken &&
        trial.deviceHash === hashDeviceToken(deviceToken),
    );
    // Every tier has a finite token limit — no unlimited bypass for paid plans.
    const effectivePlan: PlanType =
      plan.plan !== 'free' ? plan.plan : trialActive ? 'pro' : 'free';
    const catalog = await this.catalogFor(effectivePlan);
    const limit = catalog.tokenMonthlyLimit ?? FREE_MONTHLY_TOKEN_LIMIT;
    if ((plan.tokensUsedThisMonth ?? 0) >= limit) {
      throw new QuotaExceededError(workspaceId, plan.tokensUsedThisMonth ?? 0, limit);
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
      entitlementSource: updated.plan === 'free' ? 'free' : 'paid',
      entitlementState: updated.plan === 'free' ? 'free' : 'active',
      generationsUsedThisMonth: updated.generationsUsedThisMonth,
      monthlyLimit: updated.plan === 'free' ? FREE_MONTHLY_LIMIT : null,
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
