import { afterEach, describe, expect, it, vi } from 'vitest';

import { HermesAdapter } from '../../../src/infrastructure/ai/adapters/hermes/HermesAdapter.js';

afterEach(() => vi.unstubAllGlobals());

describe('HermesAdapter', () => {
  it('accepts OpenAI-compatible SSE responses even when stream=false is ignored', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'data: {"choices":[{"delta":{"content":"{\\"title\\":\\"Tes\\","}}]}',
      'data: {"choices":[{"delta":{"content":"\\"questions\\":[]}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      'data: [DONE]',
      '',
    ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })));

    const adapter = new HermesAdapter({
      live: true,
      primary: { apiKey: 'test', baseUrl: 'https://example.test/v1', modelId: 'analis', timeoutMs: 1000 },
      fallbacks: [],
    });
    const result = await adapter.generate({
      workspaceId: 'ws', promptTemplateId: 'question-generation-v1',
      schemaVersion: 1, prompt: 'buat soal', tokenEstimateHint: 10,
      contextWindowId: null, signals: {}, attemptNumber: 0, maxSchemaRepairAttempts: 1,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://example.test/v1/chat/completions',
      expect.any(Object),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('succeeded');
    if (result.value.kind !== 'succeeded') return;
    expect(JSON.parse(result.value.responseText)).toEqual({ title: 'Tes', questions: [] });
  });
});
