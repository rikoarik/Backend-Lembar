/**
 * Hermes AI adapter with automatic fallback chain.
 *
 * Primary: Hermes (Nous Research) → Fallback: OpenAI → Claude
 * If primary fails (rate limited, error, timeout), auto-route to next provider.
 *
 * Continuous learning flow:
 *   1. Generate → audit record (outcome, latency, tokens, quality)
 *   2. User feedback → ai_feedback (rating + comment + tags)
 *   3. Learning signals detect patterns
 *   4. Admin creates new prompt version
 *   5. Eval harness tests new version
 *   6. Activate better version → metrics improve
 */
import { fingerprint } from '../../../../common/redact.js';
import type {
  AiAdapterMeta,
  AiGenerateInput,
  AiGenerateOutcome,
  AiGenerateResult,
  ProductAiAdapter,
} from '../../domain/ProductAiAdapter.js';

export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  timeoutMs: number;
}

export interface HermesAdapterConfig {
  /** Primary provider (Hermes) */
  primary: ProviderConfig;
  /** Fallback providers, tried in order if primary fails */
  fallbacks: ProviderConfig[];
  /** When true, makes real HTTP calls. When false, stubs. */
  live: boolean;
}

interface ProviderResult {
  outcome: AiGenerateOutcome;
  provider: string;
}

function parseSseResponse(body: string): {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
} {
  let content = '';
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    const chunk = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    content += chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? '';
    usage = chunk.usage ?? usage;
  }
  return { choices: [{ message: { content } }], ...(usage ? { usage } : {}) };
}

/**
 * HermesAdapter with automatic fallback chain.
 * Primary: Hermes → Fallback: OpenAI → Claude → etc.
 */
export class HermesAdapter implements ProductAiAdapter {
  readonly meta: AiAdapterMeta;
  private readonly config: HermesAdapterConfig;

  constructor(config: HermesAdapterConfig) {
    if (!config.primary.apiKey) {
      throw new Error('HermesAdapter requires a primary provider API key.');
    }
    this.config = config;
    this.meta = {
      driver: 'hermes',
      providerModelId: config.primary.modelId,
    };
  }

  async generate(input: AiGenerateInput): Promise<AiGenerateResult> {
    if (!this.config.live) {
      return this.stubGenerate(input);
    }

    // Try primary (Hermes)
    const primaryResult = await this.tryProvider(this.config.primary, input, 'hermes');
    if (primaryResult.outcome.kind === 'succeeded') {
      return { ok: true, value: primaryResult.outcome };
    }

    // If rate limited or error, try fallbacks
    if (primaryResult.outcome.kind === 'rate_limited' || primaryResult.outcome.kind === 'error') {
      for (let i = 0; i < this.config.fallbacks.length; i++) {
        const fb = this.config.fallbacks[i];
        if (!fb) continue;
        const fbName = i === 0 ? 'openai' : `fallback-${i}`;
        const result = await this.tryProvider(fb, input, fbName);
        if (result.outcome.kind === 'succeeded') {
          return { ok: true, value: result.outcome };
        }
      }
    }

    // All providers failed — return primary error
    return { ok: true, value: primaryResult.outcome };
  }

  private async tryProvider(
    provider: ProviderConfig,
    input: AiGenerateInput,
    providerName: string,
  ): Promise<ProviderResult> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), provider.timeoutMs);

      const response = await fetch(`${provider.baseUrl.replace(/\/v1\/?$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: provider.modelId,
          messages: [
            { role: 'system', content: 'You are an expert Indonesian education assistant. Always respond with valid JSON.' },
            { role: 'user', content: input.prompt },
          ],
          temperature: 0.3,
          max_tokens: 4096,
          stream: false,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // Rate limited
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') ?? '60', 10) * 1000;
        return {
          outcome: {
            kind: 'rate_limited',
            providerModelId: provider.modelId,
            retryAfterMs: retryAfter,
            redactedReasonFingerprint: fingerprint(`${providerName}:rate_limited`),
          },
          provider: providerName,
        };
      }

      // Server error
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return {
          outcome: {
            kind: 'error',
            providerModelId: provider.modelId,
            redactedReasonFingerprint: fingerprint(`${providerName}:http:${response.status}:${body.length}`),
            retryable: response.status >= 500,
          },
          provider: providerName,
        };
      }

      // Some OpenAI-compatible gateways return SSE even when stream=false.
      const contentType = response.headers.get('content-type') ?? '';
      const data = (contentType.includes('text/event-stream')
        ? parseSseResponse(await response.text())
        : await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const responseText = data.choices?.[0]?.message?.content ?? '';
      if (!responseText) {
        return {
          outcome: {
            kind: 'error',
            providerModelId: provider.modelId,
            redactedReasonFingerprint: fingerprint(`${providerName}:empty_response`),
            retryable: true,
          },
          provider: providerName,
        };
      }

      // Try to parse as JSON
      try {
        JSON.parse(responseText);
      } catch {
        return {
          outcome: {
            kind: 'schema_invalid',
            providerModelId: provider.modelId,
            redactedResponseFingerprint: fingerprint(`${providerName}:parse:${responseText.length}`),
            reason: 'parse_error',
            responseText,
          },
          provider: providerName,
        };
      }

      return {
        outcome: {
          kind: 'succeeded',
          promptTemplateId: input.promptTemplateId,
          requestTokensEstimate: data.usage?.prompt_tokens ?? input.tokenEstimateHint ?? Math.ceil(input.prompt.length / 4),
          responseText,
          providerModelId: provider.modelId,
          providerRequestId: null,
        },
        provider: providerName,
      };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return {
        outcome: {
          kind: 'error',
          providerModelId: provider.modelId,
          redactedReasonFingerprint: fingerprint(`${providerName}:${isAbort ? 'timeout' : 'exception'}`),
          retryable: !isAbort,
        },
        provider: providerName,
      };
    }
  }

  // ── Stub path (safe for dev/test) ─────────────────
  private async stubGenerate(input: AiGenerateInput): Promise<AiGenerateResult> {
    await new Promise((r) => setTimeout(r, 50));

    const seed = JSON.stringify({ wid: input.workspaceId, pid: input.promptTemplateId, sv: input.schemaVersion });
    const hash = Array.from(seed).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
    const fixtureIndex = Math.abs(hash) % 3;

    const fixtures = [
      { title: 'Soal Ulangan Tengah Semester', questions: [{ question: 'Soal nomor 1 dari Hermes stub', options: ['A', 'B', 'C', 'D'], answer: 'A', explanation: 'Penjelasan stub' }] },
      { fixed_payload: {}, issues_found: [{ field: 'title', severity: 'low', description: 'Stub repair' }], summary: 'Repaired by Hermes stub' },
      { valid: true, score: 85, issues: [], recommendations: ['Tambahkan soal uraian'] },
    ];

    return {
      ok: true,
      value: {
        kind: 'succeeded',
        promptTemplateId: input.promptTemplateId,
        requestTokensEstimate: input.tokenEstimateHint ?? Math.ceil(input.prompt.length / 4),
        responseText: JSON.stringify(fixtures[fixtureIndex]),
        providerModelId: this.config.primary.modelId,
        providerRequestId: `stub-${Date.now()}`,
      },
    };
  }
}
