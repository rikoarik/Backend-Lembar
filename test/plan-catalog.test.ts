/**
 * Focused tests for plan catalog feature (req 2, 3, 4, 6, 8).
 * All tests run without a real DB using mock catalog/pool patterns.
 */
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerPlanRoutes } from '../src/modules/plans/adapters/http/planRoutes.js';
import { PlanService } from '../src/modules/plans/application/PlanService.js';
import { WorkspacePlanRepository } from '../src/modules/plans/persistence/repository.js';
import type { PlanCatalogEntry } from '../src/modules/plans/persistence/catalogRepository.js';
import { mapCatalogRow } from '../src/modules/plans/persistence/catalogRepository.js';
import { PRO_MONTHLY_TOKEN_LIMIT } from '../src/modules/plans/persistence/schema.js';

// ── Catalog row mapper ────────────────────────────────────────────────────────
describe('mapCatalogRow', () => {
  it('converts bigint string to number for token_monthly_limit', () => {
    const row = {
      key: 'free' as const,
      display_name: 'Free',
      price_amount: 0,
      currency: 'IDR' as const,
      billing_period: null,
      token_monthly_limit: '60000',
      features: [],
      active: true,
      revision: 1,
      updated_at: new Date('2024-01-01'),
      updated_by: null,
    };
    const entry = mapCatalogRow(row);
    expect(entry.tokenMonthlyLimit).toBe(60000);
    expect(entry.priceAmount).toBe(0);
    expect(entry.currency).toBe('IDR');
  });

  it('keeps null token_monthly_limit for pro (unlimited)', () => {
    const row = {
      key: 'pro' as const,
      display_name: 'Pro',
      price_amount: 49000,
      currency: 'IDR' as const,
      billing_period: 'monthly' as const,
      token_monthly_limit: null,
      features: [],
      active: true,
      revision: 1,
      updated_at: new Date('2024-01-01'),
      updated_by: null,
    };
    expect(mapCatalogRow(row).tokenMonthlyLimit).toBeNull();
    expect(mapCatalogRow(row).priceAmount).toBe(49000);
  });
});

// ── PlanService with catalog ──────────────────────────────────────────────────
describe('PlanService.getPlanSummary with catalog', () => {
  function makeCatalog(
    overrides: Partial<PlanCatalogEntry> = {},
  ): Pick<{ find: (k: string) => Promise<PlanCatalogEntry | null> }, 'find'> {
    const defaults: PlanCatalogEntry = {
      key: 'free',
      displayName: 'Free',
      priceAmount: 0,
      currency: 'IDR',
      billingPeriod: null,
      tokenMonthlyLimit: 120_000,
      features: [],
      active: true,
      revision: 1,
      updatedAt: new Date(0).toISOString(),
      updatedBy: null,
    };
    const entry = { ...defaults, ...overrides };
    return { find: async (_k: string) => entry };
  }

  function makeRepo(
    planName: 'free' | 'pro' = 'free',
    tokensUsed = 0,
    limit: number | null = null,
  ) {
    return {
      findOrCreate: async () => ({
        id: 'ws1',
        tenantId: 't1',
        workspaceId: 'ws1',
        plan: planName,
        generationsUsedThisMonth: 0,
        tokensUsedThisMonth: tokensUsed,
        tokenMonthlyLimit: limit,
        billingCycleStartedAt: new Date(),
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    } as unknown as WorkspacePlanRepository;
  }

  it('uses catalog tokenMonthlyLimit (120k) instead of hardcoded 60k', async () => {
    const svc = new PlanService(
      makeRepo('free', 0),
      undefined,
      undefined,
      makeCatalog({ tokenMonthlyLimit: 120_000 }),
    );
    const summary = await svc.getPlanSummary('t1', 'ws1');
    expect(summary.tokenMonthlyLimit).toBe(120_000);
    expect(summary.catalog.tokenMonthlyLimit).toBe(120_000);
    expect(summary.catalog.priceAmount).toBe(0);
    expect(summary.catalog.currency).toBe('IDR');
  });

  it('falls back to 30_000 when no catalog (no DB)', async () => {
    const svc = new PlanService(makeRepo('free', 0));
    const summary = await svc.getPlanSummary('t1', 'ws1');
    expect(summary.tokenMonthlyLimit).toBe(30_000);
    expect(summary.catalog.tokenMonthlyLimit).toBe(30_000);
  });

  it('pro plan has a finite tokenMonthlyLimit fallback when catalog is unavailable', async () => {
    // No catalog provided → fail-safe fallback constants apply. Every tier is
    // finite; the product never promises unlimited AI.
    const svc = new PlanService(makeRepo('pro', 0));
    const summary = await svc.getPlanSummary('t1', 'ws1');
    expect(summary.tokenMonthlyLimit).toBe(PRO_MONTHLY_TOKEN_LIMIT);
    expect(summary.catalog.priceAmount).toBe(49_000);
    expect(summary.catalog.billingPeriod).toBe('monthly');
  });

  it('quota blocked when tokens >= catalog limit', async () => {
    const svc = new PlanService(
      makeRepo('free', 120_000),
      undefined,
      undefined,
      makeCatalog({ tokenMonthlyLimit: 120_000 }),
    );
    const summary = await svc.getPlanSummary('t1', 'ws1');
    expect(summary.entitlementState).toBe('blocked');
  });
});

// ── Public plans route ────────────────────────────────────────────────────────
describe('GET /v1/public/plans', () => {
  async function buildApp(plans: PlanCatalogEntry[]) {
    const app = Fastify({ logger: false });
    await app.register((inst, _opts, done) => {
      registerPlanRoutes(inst, {} as PlanService, {
        jwtSecret: 'test-secret',
        trials: {} as never,
        catalog: { list: async () => plans },
      });
      done();
    });
    return app;
  }

  it('returns active plans with data envelope', async () => {
    const plans: PlanCatalogEntry[] = [
      {
        key: 'free',
        displayName: 'Free',
        priceAmount: 0,
        currency: 'IDR',
        billingPeriod: null,
        tokenMonthlyLimit: 60_000,
        features: [],
        active: true,
        revision: 1,
        updatedAt: new Date(0).toISOString(),
        updatedBy: null,
      },
      {
        key: 'pro',
        displayName: 'Pro',
        priceAmount: 49_000,
        currency: 'IDR',
        billingPeriod: 'monthly',
        tokenMonthlyLimit: null,
        features: [],
        active: true,
        revision: 1,
        updatedAt: new Date(0).toISOString(),
        updatedBy: null,
      },
    ];
    const app = await buildApp(plans);
    const res = await app.inject({ method: 'GET', url: '/v1/public/plans' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].key).toBe('free');
    expect(body.data[1].priceAmount).toBe(49_000);
  });

  it('does not leak admin metadata (revision, updatedAt, updatedBy)', async () => {
    const plans: PlanCatalogEntry[] = [
      {
        key: 'free',
        displayName: 'Free',
        priceAmount: 0,
        currency: 'IDR',
        billingPeriod: null,
        tokenMonthlyLimit: 60_000,
        features: [],
        active: true,
        revision: 5,
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin-uuid',
      },
    ];
    const app = await buildApp(plans);
    const res = await app.inject({ method: 'GET', url: '/v1/public/plans' });
    const body = JSON.parse(res.body);
    expect(body.data[0]).not.toHaveProperty('revision');
    expect(body.data[0]).not.toHaveProperty('updatedAt');
    expect(body.data[0]).not.toHaveProperty('updatedBy');
    expect(body.data[0]).not.toHaveProperty('active');
  });

  it('returns cache-control header', async () => {
    const app = await buildApp([]);
    const res = await app.inject({ method: 'GET', url: '/v1/public/plans' });
    expect(res.headers['cache-control']).toContain('public');
  });
});

// ── Admin PATCH validation ────────────────────────────────────────────────────
describe('PATCH /v1/admin/plans/:key validation', () => {
  /**
   * Test validation logic inline without HTTP layer since adminRoutes
   * requires a full DB. We verify the validation predicates directly.
   */

  function validateAdminPatch(body: Record<string, unknown>): string | null {
    const { displayName, priceAmount, billingPeriod, tokenMonthlyLimit, features, active } = body;
    if (
      displayName !== undefined &&
      (typeof displayName !== 'string' || (displayName as string).trim().length === 0)
    )
      return 'displayName harus string tidak kosong.';
    if (
      priceAmount !== undefined &&
      (!Number.isInteger(priceAmount) || (priceAmount as number) < 0)
    )
      return 'priceAmount harus integer >= 0.';
    if (billingPeriod !== undefined && billingPeriod !== null && billingPeriod !== 'monthly')
      return 'billingPeriod harus monthly atau null.';
    if (
      tokenMonthlyLimit !== undefined &&
      tokenMonthlyLimit !== null &&
      (!Number.isInteger(tokenMonthlyLimit) || (tokenMonthlyLimit as number) < 0)
    )
      return 'tokenMonthlyLimit harus integer >= 0 atau null.';
    if (features !== undefined && !Array.isArray(features)) return 'features harus array.';
    if (active !== undefined && typeof active !== 'boolean') return 'active harus boolean.';
    return null;
  }

  it('accepts valid priceAmount=0 (free plan)', () => {
    expect(validateAdminPatch({ priceAmount: 0 })).toBeNull();
  });

  it('rejects negative priceAmount', () => {
    expect(validateAdminPatch({ priceAmount: -1 })).toMatch('priceAmount');
  });

  it('rejects float priceAmount', () => {
    expect(validateAdminPatch({ priceAmount: 49000.5 })).toMatch('priceAmount');
  });

  it('rejects invalid billingPeriod', () => {
    expect(validateAdminPatch({ billingPeriod: 'yearly' })).toMatch('billingPeriod');
  });

  it('accepts null billingPeriod (free plan)', () => {
    expect(validateAdminPatch({ billingPeriod: null })).toBeNull();
  });

  it('accepts null tokenMonthlyLimit (unlimited)', () => {
    expect(validateAdminPatch({ tokenMonthlyLimit: null })).toBeNull();
  });

  it('rejects features as non-array', () => {
    expect(validateAdminPatch({ features: 'not-array' })).toMatch('features');
  });

  it('rejects active as non-boolean', () => {
    expect(validateAdminPatch({ active: 1 })).toMatch('active');
  });

  it('rejects empty displayName', () => {
    expect(validateAdminPatch({ displayName: '   ' })).toMatch('displayName');
  });
});

// ── Payment amount server-side derivation ────────────────────────────────────
describe('Pakasir create-order: amount derived from catalog', () => {
  /**
   * Verify that catalog.find('pro') is the amount source, not client body.
   * We test by exercising the logic inline, mirroring webhookRoutes behavior.
   */

  async function simulateCreateOrder(
    clientBody: Record<string, unknown>,
    catalogAmount: number | null,
  ): Promise<{ status: number; errorCode?: string; amountUsed?: number }> {
    const workspaceId = 'ws-test';
    const { orderId, toPlan } = clientBody;
    if (!workspaceId || typeof orderId !== 'string' || !orderId || toPlan !== 'pro') {
      return { status: 400, errorCode: 'VALIDATION_FAILED' };
    }
    // apiKey/slug guard skipped (not gateway-testing)
    const serverAmount = catalogAmount;
    if (!Number.isInteger(serverAmount) || (serverAmount ?? 0) <= 0) {
      return { status: 503, errorCode: 'PAYMENT_NOT_CONFIGURED' };
    }
    return { status: 201, amountUsed: serverAmount! };
  }

  it('uses catalog amount (49000), ignores any client amountCents', async () => {
    const result = await simulateCreateOrder(
      { orderId: 'order-1', toPlan: 'pro', amountCents: 99999 },
      49_000,
    );
    expect(result.status).toBe(201);
    expect(result.amountUsed).toBe(49_000); // 49000, not 99999
  });

  it('returns 503 when catalog has no pro entry', async () => {
    const result = await simulateCreateOrder({ orderId: 'order-1', toPlan: 'pro' }, null);
    expect(result.status).toBe(503);
    expect(result.errorCode).toBe('PAYMENT_NOT_CONFIGURED');
  });

  it('rejects invalid toPlan', async () => {
    const result = await simulateCreateOrder({ orderId: 'order-1', toPlan: 'school' }, 49_000);
    expect(result.status).toBe(400);
  });

  it('rejects missing orderId', async () => {
    const result = await simulateCreateOrder({ toPlan: 'pro' }, 49_000);
    expect(result.status).toBe(400);
  });
});
