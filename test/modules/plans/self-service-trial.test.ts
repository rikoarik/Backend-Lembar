import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';
import { registerPlanRoutes } from '../../../src/modules/plans/adapters/http/planRoutes.js';
import { PlanService } from '../../../src/modules/plans/application/PlanService.js';
import {
  FREE_MONTHLY_LIMIT,
  FREE_MONTHLY_TOKEN_LIMIT,
} from '../../../src/modules/plans/persistence/schema.js';
import {
  hashDeviceToken,
  hashIdentity,
  hashTrialClaimToken,
  TrialService,
  normalizeEmail,
  normalizeIndonesianPhone,
} from '../../../src/modules/plans/application/TrialService.js';

const now = new Date('2026-07-29T00:00:00.000Z');

function planRepo(plan: 'free' | 'pro' = 'free') {
  return {
    async findOrCreate(tenantId: string, workspaceId: string) {
      return {
        id: 'plan-1',
        tenantId,
        workspaceId,
        plan,
        generationsUsedThisMonth: 10,
        tokensUsedThisMonth: 0,
        tokenMonthlyLimit: null,
        billingCycleStartedAt: now,
        active: true,
        createdAt: now,
        updatedAt: now,
      };
    },
    async hasQuota() {
      return false;
    },
    async incrementUsage() {},
    async setPlan() {},
  };
}

function trialRepo(startsAt = new Date('2026-07-01'), endsAt = new Date('2026-08-30')) {
  return {
    async findByWorkspace() {
      return { startsAt, endsAt, deviceHash: hashDeviceToken('claimed-device') };
    },
  };
}

describe('60-day self-service Pro trial', () => {
  it('reports Pro only on the claimed device', async () => {
    const service = new PlanService(planRepo() as never, trialRepo(), () => now);
    await expect(
      service.getPlanSummary('tenant-1', 'workspace-1', 'claimed-device'),
    ).resolves.toMatchObject({
      plan: 'pro',
      entitlementSource: 'trial',
      monthlyLimit: null,
      trial: { claimed: true, activeOnThisDevice: true, remainingDays: 32 },
    });
  });

  it('keeps an active trial Free on another device', async () => {
    const service = new PlanService(planRepo() as never, trialRepo(), () => now);
    await expect(
      service.getPlanSummary('tenant-1', 'workspace-1', 'other-device'),
    ).resolves.toMatchObject({
      plan: 'free',
      entitlementSource: 'free',
      monthlyLimit: FREE_MONTHLY_LIMIT,
      tokenMonthlyLimit: FREE_MONTHLY_TOKEN_LIMIT,
      trial: { claimed: true, activeOnThisDevice: false },
    });
  });

  it('keeps paid Pro active on every device', async () => {
    const service = new PlanService(
      planRepo('pro') as never,
      {
        async findByWorkspace() {
          return null;
        },
      },
      () => now,
    );
    await expect(service.getPlanSummary('tenant-1', 'workspace-1')).resolves.toMatchObject({
      plan: 'pro',
      entitlementSource: 'paid',
      monthlyLimit: null,
    });
  });

  it('automatically reports Free after expiry without cron', async () => {
    const service = new PlanService(
      planRepo() as never,
      trialRepo(new Date('2026-05-01'), new Date('2026-06-30')),
      () => now,
    );
    await expect(
      service.getPlanSummary('tenant-1', 'workspace-1', 'claimed-device'),
    ).resolves.toMatchObject({
      plan: 'free',
      trial: { claimed: true, activeOnThisDevice: false, remainingDays: 0 },
    });
  });

  it('keeps the free token quota available on another device during a device-bound trial', async () => {
    const service = new PlanService(planRepo() as never, trialRepo(), () => now);
    await expect(
      service.assertQuota('tenant-1', 'workspace-1', 'claimed-device'),
    ).resolves.toBeUndefined();
    await expect(
      service.assertQuota('tenant-1', 'workspace-1', 'other-device'),
    ).resolves.toBeUndefined();
  });

  it('normalizes full identifiers and hashes them without collisions from masking', () => {
    expect(normalizeEmail(' Guru@Example.COM ')).toBe('guru@example.com');
    expect(normalizeIndonesianPhone('0812-3456-7890')).toBe('+6281234567890');
    expect(normalizeIndonesianPhone('+62 812 3456 7890')).toBe('+6281234567890');
    expect(hashIdentity('+6281234567890', 'pepper')).not.toBe(
      hashIdentity('+6289999967890', 'pepper'),
    );
  });

  it('derives claim identity from JWT and rejects privileged roles', async () => {
    const app = Fastify();
    let claimInput: Record<string, unknown> | undefined;
    const service = {
      async getPlanSummary() {
        return { plan: 'pro', trial: {} };
      },
    };
    const trials = {
      async issueClaimLink() {
        return {
          token: 'claim-token-long-enough-for-route',
          expiresAt: new Date(now.getTime() + 900000),
        };
      },
      async claim(input: Record<string, unknown>) {
        claimInput = input;
        return { startsAt: now, endsAt: new Date(now.getTime() + 60 * 86400000) };
      },
    };
    await registerPlanRoutes(app, service as never, {
      trials: trials as never,
      jwtSecret: 'secret',
    });
    const makeToken = (roles: Array<'subscriber' | 'school_admin' | 'superadmin'>) =>
      generateJwt(
        { userId: 'jwt-user', workspaceId: 'jwt-workspace', email: 'x@y.id', roles },
        { secret: 'secret', expiryDays: 1 },
      );
    const link = await app.inject({
      method: 'POST',
      url: '/v1/me/plan/trial/claim-links',
      headers: { authorization: 'Bearer ' + makeToken(['subscriber']) },
    });
    expect(link.statusCode).toBe(201);
    expect(link.headers['cache-control']).toBe('no-store');
    expect(link.json()).toMatchObject({
      data: { token: 'claim-token-long-enough-for-route' },
    });

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/me/plan/trial/claim',
      headers: { authorization: 'Bearer ' + makeToken(['subscriber']) },
      payload: {
        claimToken: 'claim-token-long-enough-for-route',
        deviceToken: 'device-token-long-enough',
        workspaceId: 'attacker-workspace',
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(claimInput).toMatchObject({
      userId: 'jwt-user',
      workspaceId: 'jwt-workspace',
      claimToken: 'claim-token-long-enough-for-route',
      deviceToken: 'device-token-long-enough',
    });
    for (const roles of [['school_admin'], ['superadmin']] as const) {
      const denied = await app.inject({
        method: 'POST',
        url: '/v1/me/plan/trial/claim',
        headers: { authorization: 'Bearer ' + makeToken([...roles]) },
        payload: {
          claimToken: 'claim-token-long-enough-for-route',
          deviceToken: 'device-token-long-enough',
        },
      });
      expect(denied.statusCode).toBe(403);
    }
    await app.close();
  });

  it('issues a short-lived claim link and persists only its hash', async () => {
    let captured: Record<string, unknown> | undefined;
    const rawToken = 'opaque-one-time-token-with-at-least-32-characters';
    const repo = {
      async getEligibleProfile() {
        return { email: 'guru@example.com', phone: '081234567890', plan: 'free' as const };
      },
      async issueClaimLink(input: Record<string, unknown>) {
        captured = input;
      },
    };
    const service = new TrialService(
      repo as never,
      'test-pepper-long-enough',
      () => now,
      () => rawToken,
    );

    const issued = await service.issueClaimLink({ userId: 'user-1', workspaceId: 'workspace-1' });

    expect(issued.token).toBe(rawToken);
    expect(issued.expiresAt.getTime() - now.getTime()).toBe(15 * 60 * 1000);
    expect(captured).toMatchObject({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      tokenHash: hashTrialClaimToken(rawToken),
      issuedAt: now,
      expiresAt: issued.expiresAt,
    });
    expect(JSON.stringify(captured)).not.toContain(rawToken);
  });

  it('claims exactly 60 days and persists hashes only', async () => {
    let captured: Record<string, unknown> | undefined;
    const repo = {
      async getEligibleProfile() {
        return { email: ' Guru@Example.COM ', phone: '0812-3456-7890', plan: 'free' as const };
      },
      async claim(input: Record<string, unknown>) {
        captured = input;
        return { startsAt: input.startsAt as Date, endsAt: input.endsAt as Date };
      },
    };
    const service = new TrialService(repo as never, 'test-pepper-long-enough', () => now);
    const result = await service.claim({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      claimToken: 'one-time-claim-token-with-enough-entropy',
      deviceToken: 'browser-random-token',
      ip: '127.0.0.1',
    });
    expect(result.endsAt.getTime() - result.startsAt.getTime()).toBe(60 * 86400000);
    for (const key of ['claimTokenHash', 'emailHash', 'phoneHash', 'deviceHash', 'ipHash'])
      expect(captured?.[key]).toMatch(/^[a-f0-9]{64}$/);
    expect(captured?.claimTokenHash).toBe(
      hashTrialClaimToken('one-time-claim-token-with-enough-entropy'),
    );
    const serialized = JSON.stringify(captured);
    for (const raw of [
      'one-time-claim-token-with-enough-entropy',
      'browser-random-token',
      '127.0.0.1',
      'guru@example.com',
      '+6281234567890',
    ])
      expect(serialized).not.toContain(raw);
  });

  it('requires a one-time claim link token', async () => {
    const repo = {
      async getEligibleProfile() {
        return { email: 'guru@example.com', phone: '081234567890', plan: 'free' as const };
      },
    };
    const service = new TrialService(repo as never, 'test-pepper-long-enough', () => now);

    await expect(
      service.claim({
        userId: 'user-1',
        workspaceId: 'workspace-1',
        claimToken: '',
        deviceToken: 'browser-random-token',
        ip: '127.0.0.1',
      }),
    ).rejects.toMatchObject({ code: 'TRIAL_CLAIM_LINK_REQUIRED' });
  });
});

// ponytail: email/phone ownership needs OTP; hashes prevent replay but do not prove ownership.
