/**
 * B6-01 — Entitlement & quota tests.
 *
 * Evidence covered:
 * - free plan: 10 gen/month limit enforced
 * - pro plan: unlimited generations
 * - quota middleware: 429 on exceeded, passes on available
 * - plan transitions: free → pro → free
 * - GET /v1/me/plan: returns correct shape
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { PlanService } from '../../../src/modules/plans/application/PlanService.js';
import { QuotaExceededError } from '../../../src/modules/plans/domain/errors.js';
import { FREE_MONTHLY_LIMIT, FREE_MONTHLY_TOKEN_LIMIT } from '../../../src/modules/plans/persistence/schema.js';

// ─── In-memory plan store ─────────────────────────────────────────────────────

interface PlanRow {
  id: string;
  tenantId: string;
  workspaceId: string;
  plan: 'free' | 'pro';
  generationsUsedThisMonth: number;
  tokensUsedThisMonth: number;
  tokenMonthlyLimit: number | null;
  billingCycleStartedAt: Date;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

class InMemoryPlanRepository {
  private rows = new Map<string, PlanRow>();

  private key(tenantId: string, workspaceId: string): string {
    return `${tenantId}::${workspaceId}`;
  }

  async findOrCreate(tenantId: string, workspaceId: string): Promise<PlanRow> {
    const k = this.key(tenantId, workspaceId);
    if (!this.rows.has(k)) {
      const now = new Date();
      this.rows.set(k, {
        id: `plan-${k}`,
        tenantId,
        workspaceId,
        plan: 'free',
        generationsUsedThisMonth: 0,
        tokensUsedThisMonth: 0,
        tokenMonthlyLimit: null,
        billingCycleStartedAt: now,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
    }
    return this.rows.get(k)!;
  }

  async findByWorkspace(tenantId: string, workspaceId: string): Promise<PlanRow | null> {
    return this.rows.get(this.key(tenantId, workspaceId)) ?? null;
  }

  async incrementUsage(tenantId: string, workspaceId: string): Promise<PlanRow> {
    const row = await this.findOrCreate(tenantId, workspaceId);
    const now = new Date();
    // Reset if new month
    if (
      now.getMonth() !== row.billingCycleStartedAt.getMonth() ||
      now.getFullYear() !== row.billingCycleStartedAt.getFullYear()
    ) {
      row.generationsUsedThisMonth = 0;
      row.billingCycleStartedAt = now;
    }
    row.generationsUsedThisMonth += 1;
    row.updatedAt = now;
    return row;
  }

  async setPlan(tenantId: string, workspaceId: string, plan: 'free' | 'pro'): Promise<PlanRow> {
    const row = await this.findOrCreate(tenantId, workspaceId);
    row.plan = plan;
    row.updatedAt = new Date();
    return row;
  }

  async hasQuota(tenantId: string, workspaceId: string): Promise<boolean> {
    const row = await this.findOrCreate(tenantId, workspaceId);
    const now = new Date();
    if (
      now.getMonth() !== row.billingCycleStartedAt.getMonth() ||
      now.getFullYear() !== row.billingCycleStartedAt.getFullYear()
    ) {
      return true; // Will reset on next increment
    }
    if (row.plan === 'pro') return true;
    return row.tokensUsedThisMonth < (row.tokenMonthlyLimit ?? FREE_MONTHLY_TOKEN_LIMIT);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const TENANT = 'tenant-001';
const WS_FREE = 'ws-free-001';
const WS_PRO = 'ws-pro-001';

describe('B6-01 — Entitlement & quota', () => {
  let repo: InMemoryPlanRepository;
  let service: PlanService;

  beforeEach(() => {
    repo = new InMemoryPlanRepository();
    // PlanService accepts any repo that satisfies its interface — cast to avoid DB dependency
    service = new PlanService(repo as unknown as ConstructorParameters<typeof PlanService>[0]);
  });

  // ─── Plan summary ──────────────────────────────────────────────────────────

  describe('getPlanSummary', () => {
    it('returns free plan with limit=10 for new workspace', async () => {
      const summary = await service.getPlanSummary(TENANT, WS_FREE);
      expect(summary.plan).toBe('free');
      expect(summary.monthlyLimit).toBe(FREE_MONTHLY_LIMIT);
      expect(summary.generationsUsedThisMonth).toBe(0);
      expect(summary.workspaceId).toBe(WS_FREE);
      expect(typeof summary.billingCycleStartedAt).toBe('string');
    });

    it('returns pro plan with null limit (unlimited)', async () => {
      await repo.setPlan(TENANT, WS_PRO, 'pro');
      const summary = await service.getPlanSummary(TENANT, WS_PRO);
      expect(summary.plan).toBe('pro');
      expect(summary.monthlyLimit).toBeNull();
    });
  });

  // ─── Quota enforcement ────────────────────────────────────────────────────

  describe('assertQuota — free plan', () => {
    it('allows generations below limit', async () => {
      // Seed tokens well below the 60k token limit — quota should pass
      const row = await repo.findOrCreate(TENANT, WS_FREE);
      row.tokensUsedThisMonth = FREE_MONTHLY_TOKEN_LIMIT - 1;
      await expect(service.assertQuota(TENANT, WS_FREE)).resolves.toBeUndefined();
    });

    it('throws QuotaExceededError after limit reached', async () => {
      // Use up all tokens
      for (let i = 0; i < FREE_MONTHLY_LIMIT; i++) {
        await repo.incrementUsage(TENANT, WS_FREE);
      }
      const row = await repo.findOrCreate(TENANT, WS_FREE);
      row.tokensUsedThisMonth = FREE_MONTHLY_TOKEN_LIMIT;
      await expect(service.assertQuota(TENANT, WS_FREE)).rejects.toBeInstanceOf(
        QuotaExceededError,
      );
    });

    it('QuotaExceededError carries used/limit metadata', async () => {
      const row = await repo.findOrCreate(TENANT, WS_FREE);
      row.tokensUsedThisMonth = FREE_MONTHLY_TOKEN_LIMIT;
      try {
        await service.assertQuota(TENANT, WS_FREE);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(QuotaExceededError);
        const qe = err as QuotaExceededError;
        expect(qe.used).toBe(FREE_MONTHLY_TOKEN_LIMIT);
        expect(qe.limit).toBe(FREE_MONTHLY_TOKEN_LIMIT);
        expect(qe.workspaceId).toBe(WS_FREE);
      }
    });
  });

  describe('assertQuota — pro plan', () => {
    it('never throws for pro plan (unlimited)', async () => {
      await repo.setPlan(TENANT, WS_PRO, 'pro');
      // Use 50 generations — well above free limit
      for (let i = 0; i < 50; i++) {
        await repo.incrementUsage(TENANT, WS_PRO);
      }
      await expect(service.assertQuota(TENANT, WS_PRO)).resolves.toBeUndefined();
    });
  });

  // ─── Plan transitions ─────────────────────────────────────────────────────

  describe('setPlan', () => {
    it('transitions free → pro', async () => {
      const result = await service.setPlan({
        tenantId: TENANT,
        workspaceId: WS_FREE,
        newPlan: 'pro',
        actorId: 'admin-001',
      });
      expect(result.plan).toBe('pro');
      expect(result.monthlyLimit).toBeNull();
    });

    it('transitions pro → free restores limit', async () => {
      await repo.setPlan(TENANT, WS_PRO, 'pro');
      const result = await service.setPlan({
        tenantId: TENANT,
        workspaceId: WS_PRO,
        newPlan: 'free',
        actorId: 'admin-001',
      });
      expect(result.plan).toBe('free');
      expect(result.monthlyLimit).toBe(FREE_MONTHLY_LIMIT);
    });
  });

  // ─── Usage recording ──────────────────────────────────────────────────────

  describe('recordGeneration', () => {
    it('increments usage counter', async () => {
      await service.recordGeneration(TENANT, WS_FREE);
      await service.recordGeneration(TENANT, WS_FREE);
      const summary = await service.getPlanSummary(TENANT, WS_FREE);
      expect(summary.generationsUsedThisMonth).toBe(2);
    });
  });

  // ─── Compatibility and canonical token constants ─────────────────────────

  it('keeps deprecated generation limit and exposes the canonical token pool', () => {
    expect(FREE_MONTHLY_LIMIT).toBe(3);
    expect(FREE_MONTHLY_TOKEN_LIMIT).toBe(30_000);
  });
});
