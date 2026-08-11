import { describe, expect, it } from 'vitest';
import { parseAiEnv } from '../../../src/config/ai.env.js';
import { ProductAiService } from '../../../src/infrastructure/ai/application/ProductAiService.js';
import { InMemoryAiAuditRecorder } from '../../../src/infrastructure/ai/persistence/AiAuditRepository.js';
import { PlanService } from '../../../src/modules/plans/application/PlanService.js';
import { FREE_MONTHLY_TOKEN_LIMIT } from '../../../src/modules/plans/persistence/schema.js';

describe('monthly token accounting', () => {
  it('records actual usage once per provider call identity', async () => {
    const charged = new Map<string, number>();
    const service = new ProductAiService({
      adapter: { meta: { driver: 'hermes', providerModelId: 'h' }, generate: async () => ({ ok: true, value: {
        kind: 'succeeded' as const, promptTemplateId: 'p', requestTokensEstimate: 99,
        responseText: '{"ok":true}', providerModelId: 'h', providerRequestId: 'call-1',
        promptTokensActual: 10, completionTokensActual: 4,
      } }) },
      env: parseAiEnv({} as NodeJS.ProcessEnv), schemas: new Map([['p', { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }]]),
      audit: new InMemoryAiAuditRecorder(),
      tokenUsage: { recordTokenUsage: async (_w, id, tokens) => { if (!charged.has(id)) charged.set(id, tokens); } },
    });
    const request = { workspaceId: 'w', actorId: 'a', promptTemplateId: 'p', schemaVersion: 1, prompt: 'x', schema: {}, tokenEstimateHint: null, jobId: 'job' };
    await service.run(request); await service.run(request);
    expect([...charged.values()]).toEqual([14]);
  });

  it('exposes token summary and blocks a free plan at its configured limit', async () => {
    const row = { id: 'p', tenantId: 't', workspaceId: 'w', plan: 'free' as const,
      generationsUsedThisMonth: 0, tokensUsedThisMonth: 123, tokenMonthlyLimit: 123,
      billingCycleStartedAt: new Date(), active: true, createdAt: new Date(), updatedAt: new Date() };
    const repo = { findOrCreate: async () => row, hasQuota: async () => false };
    const service = new PlanService(repo as never);
    expect(await service.getPlanSummary('t', 'w')).toMatchObject({ tokenUsedThisMonth: 123, tokenMonthlyLimit: 123, entitlementState: 'blocked' });
    await expect(service.assertQuota('t', 'w')).rejects.toMatchObject({ used: 123, limit: 123 });
    expect(FREE_MONTHLY_TOKEN_LIMIT).toBe(60_000);
  });
});
