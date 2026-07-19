/**
 * B0-08 — audit/usage persistence for the product-runtime AI adapter spike.
 *
 * The spike writes a single `ai_jobs_audit` row per outcome. The schema is
 * intentionally narrow and additive:
 *  - `driver` is enum-checked at the DB level (`mock | openai`).
 *  - `outcome` is enum-checked (`succeeded | schema_repair | rate_limited | refused | error`).
 *  - prompt body and response body are NEVER stored; only fingerprints and
 *    byteLength so logs/audit can correlate without leaking content.
 *  - `tokens_in_estimate` and `tokens_out` track the projected vs observed
 *    usage for the cost-band reporting required by the ADR.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const AI_DRIVERS = ['mock', 'openai'] as const;
export type AiDriver = (typeof AI_DRIVERS)[number];

export const AI_OUTCOMES = [
  'succeeded',
  'schema_repair',
  'rate_limited',
  'refused',
  'error',
] as const;
export type AiOutcome = (typeof AI_OUTCOMES)[number];

export const aiJobsAudit = pgTable(
  'ai_jobs_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: text('workspace_id').notNull(),
    actorId: text('actor_id').notNull(),
    promptTemplateId: text('prompt_template_id').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    providerModelId: text('provider_model_id').notNull(),
    driver: text('driver').$type<AiDriver>().notNull(),
    outcome: text('outcome').$type<AiOutcome>().notNull(),
    schemaRepairAttempts: integer('schema_repair_attempts').notNull().default(0),
    requestTokenEstimate: integer('request_token_estimate').notNull().default(0),
    responseTokenCount: integer('response_token_count'),
    tokensInEstimate: bigint('tokens_in_estimate', { mode: 'number' }).notNull().default(0),
    promptFingerprint: text('prompt_fingerprint').notNull(),
    promptByteLength: integer('prompt_byte_length').notNull(),
    responseFingerprint: text('response_fingerprint').notNull(),
    responseByteLength: integer('response_byte_length'),
    redactedError: text('redacted_error'),
    latencyMs: integer('latency_ms').notNull(),
    jobId: uuid('job_id'),
    redactedDetail: jsonb('redacted_detail'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    workspaceIdx: index('ai_jobs_audit_workspace_idx').on(t.workspaceId),
    outcomeIdx: index('ai_jobs_audit_outcome_idx').on(t.outcome),
    driverCheck: check('ai_jobs_audit_driver_check', sql`${t.driver} in ('mock','openai')`),
    outcomeCheck: check(
      'ai_jobs_audit_outcome_check',
      sql`${t.outcome} in ('succeeded','schema_repair','rate_limited','refused','error')`,
    ),
  }),
);

export type AiJobsAuditRow = typeof aiJobsAudit.$inferSelect;
export type NewAiJobsAuditRow = typeof aiJobsAudit.$inferInsert;
