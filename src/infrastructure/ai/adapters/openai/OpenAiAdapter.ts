/**
 * OpenAI adapter scaffold for the B0-08 spike.
 *
 * The adapter is **opt-in only**. The constructor refuses to instantiate
 * without a present key. Live HTTP calls are intentionally NOT performed by
 * the spike to avoid shipping production data to a paid provider before
 * owner review (D-019). Instead, the adapter proves the wiring path:
 *   - config validation
 *   - request envelope shape (prompt + schema)
 *   - response handling
 * with a documented stub that exits with the same discriminated outcome
 * set used by the live path. Replacing `sendLive` with a real HTTP call is
 * the only owner-approved change needed once D-019 is accepted.
 */
import { fingerprint } from '../../../../common/redact.js';
import type {
  AiAdapterMeta,
  AiGenerateInput,
  AiGenerateOutcome,
  AiGenerateResult,
  ProductAiAdapter,
} from '../../domain/ProductAiAdapter.js';

export interface OpenAiAdapterConfig {
  apiKey: string;
  baseUrl: string | null;
  modelId: string;
  timeoutMs: number;
  /**
   * `true` means the adapter speaks HTTP for real. The B0-08 spike keeps
   * this at `false` even when the constructor succeeds, so the spike cannot
   * accidentally emit a paid call during local runs.
   */
  live: boolean;
}

export interface OpenAiAdapterDeps {
  /** Override the HTTP transport. Always injected so tests can stay hermetic. */
  sendLive: (request: { config: OpenAiAdapterConfig; body: string }) => Promise<{
    status: number;
    bodyText: string;
    retryAfterMs: number | null;
  }>;
}

export class OpenAiAdapter implements ProductAiAdapter {
  public readonly meta: AiAdapterMeta;
  private readonly config: OpenAiAdapterConfig;
  private readonly deps: OpenAiAdapterDeps;

  constructor(config: OpenAiAdapterConfig, deps: OpenAiAdapterDeps) {
    if (!config.apiKey || config.apiKey.length === 0) {
      throw new Error('OPENAI_API_KEY required to instantiate OpenAiAdapter');
    }
    this.config = config;
    this.deps = deps;
    this.meta = { driver: 'openai', providerModelId: config.modelId };
  }

  async generate(input: AiGenerateInput): Promise<AiGenerateResult> {
    const body = JSON.stringify({
      model: this.config.modelId,
      input,
      response_format: { type: 'json_schema', schemaVersion: input.schemaVersion },
      metadata: {
        schemaRepairAttempt: input.attemptNumber,
        maxSchemaRepairAttempts: input.maxSchemaRepairAttempts,
      },
    });
    const response = await this.deps.sendLive({ config: this.config, body });
    if (response.status === 429) {
      const outcome: AiGenerateOutcome = {
        kind: 'rate_limited',
        providerModelId: this.config.modelId,
        retryAfterMs: response.retryAfterMs ?? 1_000,
        redactedReasonFingerprint: fingerprint(`status:${response.status}`),
      };
      return { ok: true, value: outcome };
    }
    if (response.status >= 400) {
      const outcome: AiGenerateOutcome = {
        kind: 'error',
        providerModelId: this.config.modelId,
        redactedReasonFingerprint: fingerprint(`status:${response.status}`),
        retryable: response.status >= 500,
      };
      return { ok: true, value: outcome };
    }
    let responseText: string;
    try {
      const parsed: unknown = JSON.parse(response.bodyText);
      const obj = parsed as { output_text?: unknown; output?: unknown };
      responseText =
        typeof obj.output_text === 'string'
          ? obj.output_text
          : typeof obj.output === 'string'
            ? obj.output
            : response.bodyText;
    } catch {
      const outcome: AiGenerateOutcome = {
        kind: 'schema_invalid',
        providerModelId: this.config.modelId,
        redactedResponseFingerprint: fingerprint(`bytes:${response.bodyText.length}`),
        reason: 'missing_json',
        responseText: null,
      };
      return { ok: true, value: outcome };
    }
    return {
      ok: true,
      value: {
        kind: 'succeeded',
        promptTemplateId: input.promptTemplateId,
        requestTokensEstimate: Math.ceil(input.prompt.length / 4),
        responseText,
        providerModelId: this.config.modelId,
        providerRequestId: null,
      },
    };
  }
}
