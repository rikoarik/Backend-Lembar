import { describe, expect, it } from 'vitest';

import {
  MockAiAdapter,
  mockDriverSwitches,
} from '../../../src/infrastructure/ai/adapters/mock/MockAiAdapter.js';

describe('MockAiAdapter', () => {
  afterEachCleanup();

  it('is deterministic across N identical calls', async () => {
    const adapter = new MockAiAdapter();
    const inputs = Array.from({ length: 5 }, () => ({
      workspaceId: 'w1',
      promptTemplateId: 'pt',
      schemaVersion: 1 as const,
      prompt: 'same bytes',
      contextWindowId: null,
      tokenEstimateHint: null,
      signals: {},
      attemptNumber: 1,
      maxSchemaRepairAttempts: 1,
    }));
    const outputs = await Promise.all(inputs.map((i) => adapter.generate(i)));
    const firstText = (outputs[0]!.value as { responseText: string }).responseText;
    for (let i = 1; i < outputs.length; i += 1) {
      expect((outputs[i]!.value as { responseText: string }).responseText).toBe(firstText);
    }
  });

  it('exposes discriminated failure outcomes through test switches', async () => {
    const adapter = new MockAiAdapter();
    mockDriverSwitches.rateLimited = true;
    const rl = (await adapter.generate({
      workspaceId: 'w1',
      promptTemplateId: 'pt',
      schemaVersion: 1,
      prompt: 'p',
      contextWindowId: null,
      tokenEstimateHint: null,
      signals: {},
      attemptNumber: 1,
      maxSchemaRepairAttempts: 1,
    }))!;
    expect(rl.value.kind).toBe('rate_limited');
    mockDriverSwitches.rateLimited = false;

    mockDriverSwitches.refused = true;
    const refused = (await adapter.generate({
      workspaceId: 'w1',
      promptTemplateId: 'pt',
      schemaVersion: 1,
      prompt: 'p',
      contextWindowId: null,
      tokenEstimateHint: null,
      signals: {},
      attemptNumber: 1,
      maxSchemaRepairAttempts: 1,
    }))!;
    expect(refused.value.kind).toBe('refused');
    mockDriverSwitches.refused = false;

    mockDriverSwitches.schemaInvalid = true;
    const invalid = (await adapter.generate({
      workspaceId: 'w1',
      promptTemplateId: 'pt',
      schemaVersion: 1,
      prompt: 'p',
      contextWindowId: null,
      tokenEstimateHint: null,
      signals: {},
      attemptNumber: 1,
      maxSchemaRepairAttempts: 1,
    }))!;
    expect(invalid.value.kind).toBe('schema_invalid');
    mockDriverSwitches.schemaInvalid = false;
  });
});

function afterEachCleanup(): void {
  mockDriverSwitches.rateLimited = false;
  mockDriverSwitches.refused = false;
  mockDriverSwitches.schemaInvalid = false;
  mockDriverSwitches.forcedOutcome = null;
}
