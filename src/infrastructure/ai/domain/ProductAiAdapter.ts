/**
 * The provider-neutral AI adapter contract used by the B0-08 spike.
 *
 * Implementations must:
 *  - Return parseable JSON (any string shape) for `succeeded`.
 *  - Surface unparseable responses as `{ ok: false, error: 'schema_invalid' }` so
 *    the application layer can repair within the cap without leaking provider
 *    raw error bodies.
 *  - Surface provider rate limits and refusals as discriminated outcomes so the
 *    application layer can map them to stable envelope codes.
 *  - Never log the prompt template content or response body.
 */
export type AiGenerateOutcome =
  | {
      kind: 'succeeded';
      promptTemplateId: string;
      requestTokensEstimate: number;
      responseText: string;
      providerModelId: string;
      providerRequestId: string | null;
    }
  | {
      kind: 'schema_invalid';
      providerModelId: string;
      redactedResponseFingerprint: string;
      reason: 'missing_json' | 'parse_error' | 'schema_mismatch';
      responseText: string | null;
    }
  | {
      kind: 'rate_limited';
      providerModelId: string;
      retryAfterMs: number;
      redactedReasonFingerprint: string;
    }
  | {
      kind: 'refused';
      providerModelId: string;
      redactedReasonFingerprint: string;
    }
  | {
      kind: 'error';
      providerModelId: string;
      redactedReasonFingerprint: string;
      retryable: boolean;
    };

export interface AiGenerateInput {
  workspaceId: string;
  promptTemplateId: string;
  schemaVersion: number;
  prompt: string;
  contextWindowId: string | null;
  /**
   * Token estimate hint. If `null` the application layer falls back to a char/4
   * estimate using `AI_TOKEN_CHARS_FALLBACK` from parseAiEnv.
   */
  tokenEstimateHint: number | null;
  signals: Readonly<Record<string, string | number | boolean>>;
  /**
   * Monotonic sequence number incremented on every repair-attempt so the adapter
   * can stay stateless about the caller's repair cap.
   */
  attemptNumber: number;
  maxSchemaRepairAttempts: number;
}

export interface AiGenerateResult {
  ok: true;
  value: AiGenerateOutcome;
}

export interface AiAdapterMeta {
  driver: 'mock' | 'openai';
  providerModelId: string;
}

export interface ProductAiAdapter {
  readonly meta: AiAdapterMeta;
  generate(input: AiGenerateInput): Promise<AiGenerateResult>;
}
