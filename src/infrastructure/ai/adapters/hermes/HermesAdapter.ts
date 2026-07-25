/**
 * Hermes AI adapter for the Lembar backend.
 *
 * Connects to Nous Research Hermes API for assessment generation.
 * Supports OpenAI-compatible chat completion API (which Hermes uses).
 *
 * Continuous learning flow:
 *   1. Generate → audit record (outcome, latency, tokens, quality)
 *   2. User feedback → quality_reports + user_ratings
 *   3. Admin reviews feedback → creates new prompt version
 *   4. Eval harness tests new version
 *   5. Activate better version → metrics improve in ai_jobs_audit
 */
import { fingerprint } from '../../../../common/redact.js';
import type {
  AiAdapterMeta,
  AiGenerateInput,
  AiGenerateOutcome,
  AiGenerateResult,
  ProductAiAdapter,
} from '../../domain/ProductAiAdapter.js';

export interface HermesAdapterConfig {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  timeoutMs: number;
  /** When true, actually makes HTTP calls. When false, stubs (safe default). */
  live: boolean;
}

/**
 * HermesAdapter — speaks OpenAI-compatible chat completion API.
 * Nous Research Hermes models are served through an OpenAI-compatible endpoint.
 */
export class HermesAdapter implements ProductAiAdapter {
  readonly meta: AiAdapterMeta;

  private readonly config: HermesAdapterConfig;

  constructor(config: HermesAdapterConfig) {
    if (!config.apiKey) {
      throw new Error('HermesAdapter requires an API key.');
    }
    this.config = config;
    this.meta = { driver: 'hermes' as AiDriver, providerModelId: config.modelId };
  }

  async generate(input: AiGenerateInput): Promise<AiGenerateResult> {
    if (!this.config.live) {
      return this.stubGenerate(input);
    }
    return this.liveGenerate(input);
  }

  // ── Live HTTP path ────────────────────────────────
  private async liveGenerate(input: AiGenerateInput): Promise<AiGenerateResult> {
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

      const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.modelId,
          messages: [
            { role: 'system', content: 'You are an expert Indonesian education assistant. Always respond with valid JSON.' },
            { role: 'user', content: input.prompt },
          ],
          temperature: 0.3,
          max_tokens: 4096,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') ?? '60', 10) * 1000;
        return {
          ok: true,
          value: {
            kind: 'rate_limited',
            providerModelId: this.config.modelId,
            retryAfterMs: retryAfter,
            redactedReasonFingerprint: fingerprint('rate_limited'),
          },
        };
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return {
          ok: true,
          value: {
            kind: 'error',
            providerModelId: this.config.modelId,
            redactedReasonFingerprint: fingerprint(`http:${response.status}:${body.length}`),
            retryable: response.status >= 500,
          },
        };
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const responseText = data.choices?.[0]?.message?.content ?? '';
      if (!responseText) {
        return {
          ok: true,
          value: {
            kind: 'error',
            providerModelId: this.config.modelId,
            redactedReasonFingerprint: fingerprint('empty_response'),
            retryable: true,
          },
        };
      }

      // Try to parse as JSON
      try {
        JSON.parse(responseText);
      } catch {
        return {
          ok: true,
          value: {
            kind: 'schema_invalid',
            providerModelId: this.config.modelId,
            redactedResponseFingerprint: fingerprint(`parse:${responseText.length}`),
            reason: 'parse_error',
            responseText,
          },
        };
      }

      return {
        ok: true,
        value: {
          kind: 'succeeded',
          promptTemplateId: input.promptTemplateId,
          requestTokensEstimate: data.usage?.prompt_tokens ?? input.tokenEstimateHint ?? Math.ceil(input.prompt.length / 4),
          responseText,
          providerModelId: this.config.modelId,
          providerRequestId: null,
        },
      };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return {
        ok: true,
        value: {
          kind: 'error',
          providerModelId: this.config.modelId,
          redactedReasonFingerprint: fingerprint(isAbort ? 'timeout' : `err:${String(err).length}`),
          retryable: !isAbort,
        },
      };
    }
  }

  // ── Stub path (safe for dev/test) ─────────────────
  private async stubGenerate(input: AiGenerateInput): Promise<AiGenerateResult> {
    await new Promise((r) => setTimeout(r, 50)); // simulate latency

    // Deterministic fixture based on input
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
        providerModelId: this.config.modelId,
        providerRequestId: `stub-${Date.now()}`,
      },
    };
  }
}

export type AiDriver = 'mock' | 'openai' | 'hermes';
