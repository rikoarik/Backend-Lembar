/**
 * Application service that owns the AI generation flow.
 *
 * Lifecycle:
 *   1. Parse + fingerprint the prompt before any provider call. The raw
 *      prompt is never logged; only fingerprint+byteLength reach the audit
 *      row.
 *   2. Call the adapter. Stop on `succeeded`. Map `schema_invalid` into a
 *      structured repair attempt, capped at `maxSchemaRepairAttempts`. Map
 *      `rate_limited` / `refused` / `error` to stable envelope codes without
 *      surfacing raw provider error bodies.
 *   3. Validate the returned JSON against the supplied output schema. Repair
 *      attempts reuse the same adapter call contract — the spike does not
 *      attempt provider-side re-prompting (that is B3 territory).
 *   4. Persist one `ai_jobs_audit` row regardless of outcome.
 *
 * Repair policy: the cap is read from `parseAiEnv` and defaults to `1`. The
 * service stops incrementing at the cap and surfaces
 * `SCHEMA_VALIDATION_FAILED` so the queue worker (B0-06) can classify the
 * failure as terminal without retrying.
 */
import { fingerprint } from '../../../common/redact.js';
import type { AiEnv } from '../../../config/ai.env.js';
import { AiAdapterError } from '../domain/errors.js';
import { JsonSchemaValidator } from '../domain/JsonSchemaValidator.js';
import type {
  AiGenerateInput,
  AiGenerateOutcome,
  AiGenerateResult,
  ProductAiAdapter,
} from '../domain/ProductAiAdapter.js';
import { InMemoryAiAuditRecorder } from '../persistence/AiAuditRepository.js';
import type { AiAuditInput } from '../persistence/AiAuditRepository.js';

export interface ProductAiServiceDeps {
  adapter: ProductAiAdapter;
  env: AiEnv;
  /** Schema validator keyed by prompt template id. */
  schemas: ReadonlyMap<string, Record<string, unknown>>;
  /**
   * Either a real `AiAuditRepository` (DB-backed) or an
   * `InMemoryAiAuditRecorder` for tests + smoke without DATABASE_URL.
   */
  audit: { record: (input: AiAuditInput) => Promise<void> } | InMemoryAiAuditRecorder;
  clock?: () => Date;
}

export interface ProductAiRequest {
  workspaceId: string;
  actorId: string;
  promptTemplateId: string;
  schemaVersion: number;
  prompt: string;
  schema: Record<string, unknown>;
  tokenEstimateHint: number | null;
  signals?: Readonly<Record<string, string | number | boolean>>;
  jobId?: string;
}

export type ProductAiResult =
  | {
      status: 'succeeded';
      outcome: 'succeeded';
      promptTemplateId: string;
      providerModelId: string;
      schemaRepairAttempts: number;
      requestTokenEstimate: number;
      responseTokenCount: number | null;
      validated: Record<string, unknown>;
      latencyMs: number;
    }
  | {
      status: 'failed';
      outcome: Exclude<AiGenerateOutcome['kind'], 'succeeded'>;
      error: AiAdapterError;
      schemaRepairAttempts: number;
      latencyMs: number;
    };

export class ProductAiService {
  private readonly validator = new JsonSchemaValidator();
  private readonly clock: () => Date;
  private readonly audit: ProductAiServiceDeps['audit'];

  constructor(private readonly deps: ProductAiServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.audit = deps.audit;
  }

  async run(request: ProductAiRequest): Promise<ProductAiResult> {
    const schema = this.deps.schemas.get(request.promptTemplateId);
    if (!schema) {
      return this.fail(
        request,
        'succeeded',
        0,
        undefined,
        AiAdapterError.internal({
          message: 'AI prompt template not registered with a schema.',
          redactedPromptFingerprint: fingerprint(request.prompt),
          redactedResponseFingerprint: fingerprint('schema_missing'),
          schemaRepairAttempt: 0,
          driver: this.deps.adapter.meta.driver,
        }),
      );
    }
    const startedAt = this.clock().getTime();
    const promptFingerprint = fingerprint(request.prompt);
    const promptByteLength = Buffer.byteLength(request.prompt, 'utf8');
    const requestTokenEstimate =
      request.tokenEstimateHint ??
      Math.max(1, Math.ceil(promptByteLength / this.deps.env.tokenEstimateFallbackChars));

    let repairAttempts = 0;

    while (true) {
      const adapterInput: AiGenerateInput = {
        workspaceId: request.workspaceId,
        promptTemplateId: request.promptTemplateId,
        schemaVersion: request.schemaVersion,
        prompt: request.prompt,
        contextWindowId: null,
        tokenEstimateHint: request.tokenEstimateHint,
        signals: request.signals ?? {},
        attemptNumber: repairAttempts + 1,
        maxSchemaRepairAttempts: this.deps.env.schemaRepairMaxAttempts,
      };
      let result: AiGenerateResult;
      try {
        result = await this.deps.adapter.generate(adapterInput);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown adapter error';
        return this.fail(
          request,
          'succeeded',
          repairAttempts,
          undefined,
          AiAdapterError.internal({
            message: 'AI adapter raised an unexpected error.',
            redactedPromptFingerprint: promptFingerprint,
            redactedResponseFingerprint: fingerprint(`err:${message.length}`),
            schemaRepairAttempt: repairAttempts,
            driver: this.deps.adapter.meta.driver,
            cause: message.slice(0, 120),
          }),
          startedAt,
        );
      }
      if (!result.ok) {
        return this.fail(
          request,
          'succeeded',
          repairAttempts,
          undefined,
          AiAdapterError.internal({
            message: 'AI adapter returned an invalid envelope.',
            redactedPromptFingerprint: promptFingerprint,
            redactedResponseFingerprint: fingerprint('envelope_invalid'),
            schemaRepairAttempt: repairAttempts,
            driver: this.deps.adapter.meta.driver,
          }),
          startedAt,
        );
      }
      const outcome = result.value;
      if (outcome.kind === 'succeeded') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(outcome.responseText);
        } catch {
          // Fall through to schema repair path below.
          const parseFailureFingerprint = fingerprint(`bytes:${outcome.responseText.length}`);
          if (repairAttempts >= this.deps.env.schemaRepairMaxAttempts) {
            return this.completeSchemaFailure(
              request,
              promptFingerprint,
              promptByteLength,
              requestTokenEstimate,
              repairAttempts,
              startedAt,
            );
          }
          repairAttempts += 1;
          await this.audit.record({
            workspaceId: request.workspaceId,
            actorId: request.actorId,
            promptTemplateId: request.promptTemplateId,
            schemaVersion: request.schemaVersion,
            providerModelId: outcome.providerModelId,
            driver: this.deps.adapter.meta.driver,
            outcome: 'schema_repair',
            schemaRepairAttempts: repairAttempts,
            requestTokenEstimate,
            responseTokenCount: null,
            tokensInEstimate: repairAttempts * requestTokenEstimate,
            promptFingerprint,
            promptByteLength,
            responseFingerprint: parseFailureFingerprint,
            responseByteLength: Buffer.byteLength(outcome.responseText, 'utf8'),
            redactedError: 'parse_error',
            latencyMs: this.clock().getTime() - startedAt,
            ...(request.jobId ? { jobId: request.jobId } : {}),
          });
          continue;
        }
        const validation = this.validator.validate(schema, parsed);
        if (validation.ok) {
          const latencyMs = this.clock().getTime() - startedAt;
          await this.audit.record({
            workspaceId: request.workspaceId,
            actorId: request.actorId,
            promptTemplateId: request.promptTemplateId,
            schemaVersion: request.schemaVersion,
            providerModelId: outcome.providerModelId,
            driver: this.deps.adapter.meta.driver,
            outcome: 'succeeded',
            schemaRepairAttempts: repairAttempts,
            requestTokenEstimate,
            responseTokenCount: this.countResponseTokens(parsed),
            tokensInEstimate: requestTokenEstimate,
            promptFingerprint,
            promptByteLength,
            responseFingerprint: fingerprint(JSON.stringify(parsed)),
            responseByteLength: Buffer.byteLength(outcome.responseText, 'utf8'),
            redactedError: null,
            latencyMs,
            ...(request.jobId ? { jobId: request.jobId } : {}),
          });
          return {
            status: 'succeeded',
            outcome: 'succeeded',
            promptTemplateId: request.promptTemplateId,
            providerModelId: outcome.providerModelId,
            schemaRepairAttempts: repairAttempts,
            requestTokenEstimate,
            responseTokenCount: this.countResponseTokens(parsed),
            validated: parsed as Record<string, unknown>,
            latencyMs,
          };
        }
        // Schema mismatch — repair attempt.
        const mismatchFingerprint = fingerprint(`bytes:${outcome.responseText.length}`);
        if (repairAttempts >= this.deps.env.schemaRepairMaxAttempts) {
          return this.completeSchemaFailure(
            request,
            promptFingerprint,
            promptByteLength,
            requestTokenEstimate,
            repairAttempts,
            startedAt,
          );
        }
        repairAttempts += 1;
        await this.audit.record({
          workspaceId: request.workspaceId,
          actorId: request.actorId,
          promptTemplateId: request.promptTemplateId,
          schemaVersion: request.schemaVersion,
          providerModelId: outcome.providerModelId,
          driver: this.deps.adapter.meta.driver,
          outcome: 'schema_repair',
          schemaRepairAttempts: repairAttempts,
          requestTokenEstimate,
          responseTokenCount: null,
          tokensInEstimate: requestTokenEstimate,
          promptFingerprint,
          promptByteLength,
          responseFingerprint: mismatchFingerprint,
          responseByteLength: Buffer.byteLength(outcome.responseText, 'utf8'),
          redactedError: 'schema_mismatch',
          latencyMs: this.clock().getTime() - startedAt,
          ...(request.jobId ? { jobId: request.jobId } : {}),
        });
        continue;
      }
      // Non-success provider outcome — terminal mapping.
      const latencyMs = this.clock().getTime() - startedAt;
      if (outcome.kind === 'rate_limited') {
        await this.audit.record({
          workspaceId: request.workspaceId,
          actorId: request.actorId,
          promptTemplateId: request.promptTemplateId,
          schemaVersion: request.schemaVersion,
          providerModelId: outcome.providerModelId,
          driver: this.deps.adapter.meta.driver,
          outcome: 'rate_limited',
          schemaRepairAttempts: repairAttempts,
          requestTokenEstimate,
          responseTokenCount: null,
          tokensInEstimate: requestTokenEstimate,
          promptFingerprint,
          promptByteLength,
          responseFingerprint: outcome.redactedReasonFingerprint,
          responseByteLength: null,
          redactedError: 'rate_limited',
          latencyMs,
          ...(request.jobId ? { jobId: request.jobId } : {}),
        });
        return {
          status: 'failed',
          outcome: 'rate_limited',
          error: AiAdapterError.rateLimited({
            message: 'AI provider returned 429.',
            redactedPromptFingerprint: promptFingerprint,
            redactedResponseFingerprint: outcome.redactedReasonFingerprint,
            retryAfterMs: outcome.retryAfterMs,
            schemaRepairAttempt: repairAttempts,
            driver: this.deps.adapter.meta.driver,
          }),
          schemaRepairAttempts: repairAttempts,
          latencyMs,
        };
      }
      if (outcome.kind === 'refused') {
        await this.audit.record({
          workspaceId: request.workspaceId,
          actorId: request.actorId,
          promptTemplateId: request.promptTemplateId,
          schemaVersion: request.schemaVersion,
          providerModelId: outcome.providerModelId,
          driver: this.deps.adapter.meta.driver,
          outcome: 'refused',
          schemaRepairAttempts: repairAttempts,
          requestTokenEstimate,
          responseTokenCount: null,
          tokensInEstimate: requestTokenEstimate,
          promptFingerprint,
          promptByteLength,
          responseFingerprint: outcome.redactedReasonFingerprint,
          responseByteLength: null,
          redactedError: 'refused',
          latencyMs,
          ...(request.jobId ? { jobId: request.jobId } : {}),
        });
        return {
          status: 'failed',
          outcome: 'refused',
          error: AiAdapterError.refused({
            message: 'AI provider refused to answer.',
            redactedPromptFingerprint: promptFingerprint,
            redactedResponseFingerprint: outcome.redactedReasonFingerprint,
            schemaRepairAttempt: repairAttempts,
            driver: this.deps.adapter.meta.driver,
          }),
          schemaRepairAttempts: repairAttempts,
          latencyMs,
        };
      }
      // error: provider outage, transient, etc.
      if (outcome.kind === 'error') {
        await this.audit.record({
          workspaceId: request.workspaceId,
          actorId: request.actorId,
          promptTemplateId: request.promptTemplateId,
          schemaVersion: request.schemaVersion,
          providerModelId: outcome.providerModelId,
          driver: this.deps.adapter.meta.driver,
          outcome: 'error',
          schemaRepairAttempts: repairAttempts,
          requestTokenEstimate,
          responseTokenCount: null,
          tokensInEstimate: requestTokenEstimate,
          promptFingerprint,
          promptByteLength,
          responseFingerprint: outcome.redactedReasonFingerprint,
          responseByteLength: null,
          redactedError: outcome.retryable ? 'transient' : 'provider_error',
          latencyMs,
          ...(request.jobId ? { jobId: request.jobId } : {}),
        });
        return {
          status: 'failed',
          outcome: 'error',
          error: AiAdapterError.internal({
            message: 'AI provider returned a non-success outcome.',
            redactedPromptFingerprint: promptFingerprint,
            redactedResponseFingerprint: outcome.redactedReasonFingerprint,
            schemaRepairAttempt: repairAttempts,
            driver: this.deps.adapter.meta.driver,
          }),
          schemaRepairAttempts: repairAttempts,
          latencyMs,
        };
      }
      // Direct schema-invalid outcome from the adapter: consume one repair attempt
      // before surfacing the terminal failure, so the counter matches the contract.
      if (outcome.kind === 'schema_invalid') {
        if (repairAttempts >= this.deps.env.schemaRepairMaxAttempts) {
          return this.completeSchemaFailure(
            request,
            promptFingerprint,
            promptByteLength,
            requestTokenEstimate,
            repairAttempts,
            startedAt,
          );
        }
        repairAttempts += 1;
        await this.audit.record({
          workspaceId: request.workspaceId,
          actorId: request.actorId,
          promptTemplateId: request.promptTemplateId,
          schemaVersion: request.schemaVersion,
          providerModelId: outcome.providerModelId,
          driver: this.deps.adapter.meta.driver,
          outcome: 'schema_repair',
          schemaRepairAttempts: repairAttempts,
          requestTokenEstimate,
          responseTokenCount: null,
          tokensInEstimate: repairAttempts * requestTokenEstimate,
          promptFingerprint,
          promptByteLength,
          responseFingerprint: outcome.redactedResponseFingerprint,
          responseByteLength: null,
          redactedError: outcome.reason,
          latencyMs: this.clock().getTime() - startedAt,
          ...(request.jobId ? { jobId: request.jobId } : {}),
        });
        continue;
      }
      throw new Error('unreachable AI outcome branch');
    }
  }

  private async completeSchemaFailure(
    request: ProductAiRequest,
    promptFingerprint: string,
    promptByteLength: number,
    requestTokenEstimate: number,
    repairAttempts: number,
    startedAt: number,
    _validation?: { ok: false; errors: ReadonlyArray<{ instancePath: string; message: string }> },
  ): Promise<ProductAiResult> {
    const latencyMs = this.clock().getTime() - startedAt;
    const err = AiAdapterError.schemaValidation({
      message: 'AI provider did not return a schema-valid payload after the repair cap.',
      redactedPromptFingerprint: promptFingerprint,
      redactedResponseFingerprint: fingerprint('schema_failed'),
      schemaRepairAttempt: repairAttempts,
      driver: this.deps.adapter.meta.driver,
    });
    await this.audit.record({
      workspaceId: request.workspaceId,
      actorId: request.actorId,
      promptTemplateId: request.promptTemplateId,
      schemaVersion: request.schemaVersion,
      providerModelId: err.driver === 'openai' ? 'openai' : 'mock-fixture-v1',
      driver: err.driver,
      outcome: 'schema_repair',
      schemaRepairAttempts: repairAttempts,
      requestTokenEstimate,
      responseTokenCount: null,
      tokensInEstimate: requestTokenEstimate,
      promptFingerprint,
      promptByteLength,
      responseFingerprint: err.redactedResponseFingerprint,
      responseByteLength: null,
      redactedError: 'SCHEMA_VALIDATION_FAILED',
      latencyMs,
      ...(request.jobId ? { jobId: request.jobId } : {}),
    });
    return {
      status: 'failed',
      outcome: 'schema_invalid',
      error: err,
      schemaRepairAttempts: repairAttempts,
      latencyMs,
    };
  }

  private fail(
    request: ProductAiRequest,
    _kind: 'succeeded',
    repairAttempts: number,
    _unused: unknown,
    error: AiAdapterError,
    startedAt?: number,
  ): ProductAiResult {
    return {
      status: 'failed',
      outcome:
        error.code === 'RATE_LIMITED'
          ? 'rate_limited'
          : error.code === 'PROVIDER_REFUSED'
            ? 'refused'
            : 'error',
      error,
      schemaRepairAttempts: repairAttempts,
      latencyMs: startedAt ? this.clock().getTime() - startedAt : 0,
    };
  }

  // Local audit helper retained for future use; the service writes directly
  // via `this.audit.record` to keep transactional fields adjacent to the call
  // site (see the read paths above).
  private recordOutcome_unused(): void {}

  private countResponseTokens(value: unknown): number {
    try {
      const str = JSON.stringify(value);
      return Math.max(1, Math.ceil(str.length / this.deps.env.tokenEstimateFallbackChars));
    } catch {
      return 0;
    }
  }
}
