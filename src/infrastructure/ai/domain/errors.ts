/**
 * Stable envelope codes emitted by the product-runtime AI adapter spike.
 *
 * The full catalog is the owner-approved list; this module exposes the
 * subset the spike proves. Each error maps to one StableErrorCode through
 * the existing envelope, and the raw provider response body is never
 * surfaced.
 */
import { fingerprint } from '../../../common/redact.js';
import type { AiProviderOutcome } from '../../../config/ai.env.js';

export interface AiAdapterErrorInit {
  code: 'SCHEMA_VALIDATION_FAILED' | 'RATE_LIMITED' | 'PROVIDER_REFUSED' | 'INTERNAL_ERROR';
  message: string;
  outcome: AiProviderOutcome;
  redactedPromptFingerprint: string;
  redactedResponseFingerprint: string;
  retryAfterMs?: number;
  schemaRepairAttempt: number;
  driver: 'mock' | 'openai';
  cause?: string;
}

export class AiAdapterError extends Error {
  public readonly code: AiAdapterErrorInit['code'];
  public readonly outcome: AiProviderOutcome;
  public readonly redactedPromptFingerprint: string;
  public readonly redactedResponseFingerprint: string;
  public readonly retryAfterMs: number | null;
  public readonly schemaRepairAttempt: number;
  public readonly driver: 'mock' | 'openai';
  public override readonly cause: string | null;

  constructor(init: AiAdapterErrorInit) {
    super(init.message);
    this.name = 'AiAdapterError';
    this.code = init.code;
    this.outcome = init.outcome;
    this.redactedPromptFingerprint = init.redactedPromptFingerprint;
    this.redactedResponseFingerprint = init.redactedResponseFingerprint;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.schemaRepairAttempt = init.schemaRepairAttempt;
    this.driver = init.driver;
    this.cause = init.cause ?? null;
  }

  static schemaValidation(init: Omit<AiAdapterErrorInit, 'code' | 'outcome'>): AiAdapterError {
    return new AiAdapterError({
      ...init,
      code: 'SCHEMA_VALIDATION_FAILED',
      outcome: 'schema_repair',
    });
  }

  static rateLimited(init: Omit<AiAdapterErrorInit, 'code' | 'outcome'>): AiAdapterError {
    return new AiAdapterError({ ...init, code: 'RATE_LIMITED', outcome: 'rate_limited' });
  }

  static refused(init: Omit<AiAdapterErrorInit, 'code' | 'outcome'>): AiAdapterError {
    return new AiAdapterError({ ...init, code: 'PROVIDER_REFUSED', outcome: 'refused' });
  }

  static internal(init: Omit<AiAdapterErrorInit, 'code' | 'outcome'>): AiAdapterError {
    return new AiAdapterError({ ...init, code: 'INTERNAL_ERROR', outcome: 'error' });
  }
}

export function fingerprintString(value: string): string {
  return fingerprint(value);
}
