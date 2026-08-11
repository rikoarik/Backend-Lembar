import { afterEach, describe, expect, it, vi } from 'vitest';
import { HermesAdapter } from '../../../src/infrastructure/ai/adapters/hermes/HermesAdapter.js';

const input = {
  workspaceId: 'w1', promptTemplateId: 'p1', schemaVersion: 1, prompt: 'buat soal',
  contextWindowId: null, tokenEstimateHint: 9, signals: {}, attemptNumber: 1,
  maxSchemaRepairAttempts: 1,
};
const adapter = () => new HermesAdapter({
  primary: { apiKey: 'test', baseUrl: 'https://example.test', modelId: 'hermes', timeoutMs: 1000 },
  fallbacks: [], live: true,
});

afterEach(() => vi.restoreAllMocks());

describe('Hermes actual token usage', () => {
  it('propagates JSON usage and provider request id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'call-json', choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    }), { headers: { 'content-type': 'application/json' } })));
    const result = await adapter().generate(input);
    expect(result.value).toMatchObject({ kind: 'succeeded', providerRequestId: 'call-json', promptTokensActual: 12, completionTokensActual: 7 });
  });

  it('propagates SSE usage', async () => {
    const body = 'data: {"id":"call-sse","choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n' +
      'data: {"id":"call-sse","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":5}}\n' +
      'data: [DONE]\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } })));
    const result = await adapter().generate(input);
    expect(result.value).toMatchObject({ kind: 'succeeded', providerRequestId: 'call-sse', promptTokensActual: 20, completionTokensActual: 5 });
  });
});
