/**
 * Minimal insert helper for the AI audit row.
 *
 * The B0-08 spike persists through the accepted Drizzle handle. The shape is
 * fixed by `src/infrastructure/ai/persistence/schema.ts`. Tests do not need
 * a real DB — they use an in-memory `AiAuditRecorder` from the application
 * layer when `db` is undefined.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../../database/db.js';
import { aiJobsAudit, type AiDriver, type AiOutcome, type NewAiJobsAuditRow } from './schema.js';

export interface AiAuditInput {
  workspaceId: string;
  actorId: string;
  promptTemplateId: string;
  schemaVersion: number;
  providerModelId: string;
  driver: AiDriver;
  outcome: AiOutcome;
  schemaRepairAttempts: number;
  requestTokenEstimate: number;
  responseTokenCount: number | null;
  tokensInEstimate: number;
  promptFingerprint: string;
  promptByteLength: number;
  responseFingerprint: string;
  responseByteLength: number | null;
  redactedError: string | null;
  latencyMs: number;
  jobId?: string;
  redactedDetail?: Record<string, unknown> | null;
}

export class AiAuditRepository {
  constructor(private readonly db: Database | null) {}

  async record(input: AiAuditInput): Promise<void> {
    if (!this.db) {
      throw new Error('AiAuditRepository requires a Database handle in this build');
    }
    const row: NewAiJobsAuditRow = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      promptTemplateId: input.promptTemplateId,
      schemaVersion: input.schemaVersion,
      providerModelId: input.providerModelId,
      driver: input.driver,
      outcome: input.outcome,
      schemaRepairAttempts: input.schemaRepairAttempts,
      requestTokenEstimate: input.requestTokenEstimate,
      responseTokenCount: input.responseTokenCount,
      tokensInEstimate: input.tokensInEstimate,
      promptFingerprint: input.promptFingerprint,
      promptByteLength: input.promptByteLength,
      responseFingerprint: input.responseFingerprint,
      responseByteLength: input.responseByteLength,
      redactedError: input.redactedError,
      latencyMs: input.latencyMs,
      jobId: input.jobId ?? null,
      redactedDetail: input.redactedDetail ?? null,
      createdAt: new Date(),
    };
    await this.db.execute(sql`
      INSERT INTO "ai_jobs_audit" (
        "id", "workspace_id", "actor_id", "prompt_template_id", "schema_version",
        "provider_model_id", "driver", "outcome", "schema_repair_attempts",
        "request_token_estimate", "response_token_count", "tokens_in_estimate",
        "prompt_fingerprint", "prompt_byte_length", "response_fingerprint",
        "response_byte_length", "redacted_error", "latency_ms", "job_id",
        "redacted_detail", "created_at"
      ) VALUES (
        ${row.id}, ${row.workspaceId}, ${row.actorId}, ${row.promptTemplateId},
        ${row.schemaVersion}, ${row.providerModelId}, ${row.driver}, ${row.outcome},
        ${row.schemaRepairAttempts}, ${row.requestTokenEstimate},
        ${row.responseTokenCount}, ${row.tokensInEstimate}, ${row.promptFingerprint},
        ${row.promptByteLength}, ${row.responseFingerprint}, ${row.responseByteLength},
        ${row.redactedError}, ${row.latencyMs}, ${row.jobId}, ${row.redactedDetail},
        ${row.createdAt}
      )
    `);
    // Suppress unused-import lint when the drizzle table is referenced via raw SQL only.
    void aiJobsAudit;
  }
}

/** In-memory recorder used by tests and the smoke script to avoid DATABASE_URL. */
export class InMemoryAiAuditRecorder {
  private readonly rows: AiAuditInput[] = [];

  async record(input: AiAuditInput): Promise<void> {
    this.rows.push(input);
  }

  rowsSnapshot(): readonly AiAuditInput[] {
    return [...this.rows];
  }

  count(): number {
    return this.rows.length;
  }

  byOutcome(outcome: AiOutcome): readonly AiAuditInput[] {
    return this.rows.filter((row) => row.outcome === outcome);
  }

  byDriver(driver: AiDriver): readonly AiAuditInput[] {
    return this.rows.filter((row) => row.driver === driver);
  }
}
