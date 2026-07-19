import { describe, expect, it } from 'vitest';

import { OpenAiAdapter } from '../../../src/infrastructure/ai/adapters/openai/OpenAiAdapter.js';

describe('OpenAiAdapter', () => {
  it('refuses to instantiate without an API key', () => {
    expect(
      () =>
        new OpenAiAdapter(
          {
            apiKey: '',
            baseUrl: null,
            modelId: 'gpt-test',
            timeoutMs: 1_000,
            live: true,
          },
          { sendLive: async () => ({ status: 200, bodyText: '{}', retryAfterMs: null }) },
        ),
    ).toThrow();
  });

  it('maps 429 to a rate_limited outcome with retry-after', async () => {
    const adapter = new OpenAiAdapter(
      {
        apiKey: 'preview-key',
        baseUrl: null,
        modelId: 'gpt-test',
        timeoutMs: 1_000,
        live: true,
      },
      { sendLive: async () => ({ status: 429, bodyText: '{}', retryAfterMs: 2_500 }) },
    );
    const result = await adapter.generate({
      workspaceId: 'w1',
      promptTemplateId: 'pt',
      schemaVersion: 1,
      prompt: 'p',
      contextWindowId: null,
      tokenEstimateHint: null,
      signals: {},
      attemptNumber: 1,
      maxSchemaRepairAttempts: 1,
    });
    if (!result.ok) throw new Error('expected ok=true');
    if (result.value.kind !== 'rate_limited') throw new Error('expected rate_limited');
    expect(result.value.retryAfterMs).toBe(2_500);
  });

  it('maps 5xx to a retryable error outcome', async () => {
    const adapter = new OpenAiAdapter(
      {
        apiKey: 'preview-key',
        baseUrl: null,
        modelId: 'gpt-test',
        timeoutMs: 1_000,
        live: true,
      },
      { sendLive: async () => ({ status: 503, bodyText: 'down', retryAfterMs: null }) },
    );
    const result = await adapter.generate({
      workspaceId: 'w1',
      promptTemplateId: 'pt',
      schemaVersion: 1,
      prompt: 'p',
      contextWindowId: null,
      tokenEstimateHint: null,
      signals: {},
      attemptNumber: 1,
      maxSchemaRepairAttempts: 1,
    });
    if (!result.ok) throw new Error('expected ok=true');
    if (result.value.kind !== 'error') throw new Error('expected error');
    expect(result.value.retryable).toBe(true);
  });

  it('maps 200 success envelope to a succeeded outcome', async () => {
    const adapter = new OpenAiAdapter(
      {
        apiKey: 'preview-key',
        baseUrl: null,
        modelId: 'gpt-test',
        timeoutMs: 1_000,
        live: true,
      },
      {
        sendLive: async () => ({
          status: 200,
          bodyText: JSON.stringify({ output_text: '{"answer":"ok"}' }),
          retryAfterMs: null,
        }),
      },
    );
    const result = await adapter.generate({
      workspaceId: 'w1',
      promptTemplateId: 'pt',
      schemaVersion: 1,
      prompt: 'p',
      contextWindowId: null,
      tokenEstimateHint: null,
      signals: {},
      attemptNumber: 1,
      maxSchemaRepairAttempts: 1,
    });
    if (!result.ok) throw new Error('expected ok=true');
    if (result.value.kind !== 'succeeded') throw new Error('expected succeeded');
    expect(result.value.responseText).toBe('{"answer":"ok"}');
  });
});
