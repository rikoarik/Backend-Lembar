/**
 * Queue spike persistence schema (B0-06).
 *
 * This module is intentionally narrow: it declares the four tables the queue/idempotency
 * spike needs without touching the auth-relevant tables in `src/infrastructure/database/schema.ts`.
 *
 * The spike proves business invariants over these tables; production durability and any
 * Postgres-side tuning land in later tasks.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const JOB_STATUSES = [
  'created',
  'queued',
  'running',
  'retry_wait',
  'succeeded',
  'partially_succeeded',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_KINDS = [
  'source_ingestion',
  'assessment_generation',
  'question_regeneration',
  'export_pdf',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const jobs = pgTable(
  'spike_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: text('workspace_id').notNull(),
    actorId: text('actor_id').notNull(),
    kind: text('kind').$type<JobKind>().notNull(),
    status: text('status').$type<JobStatus>().notNull(),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    leaseTtlMs: integer('lease_ttl_ms').notNull().default(30000),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true, mode: 'date' }),
    payload: jsonb('payload').notNull(),
    quotaUnits: integer('quota_units').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
    lastError: jsonb('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    workspaceStatusIdx: uniqueIndex('spike_jobs_workspace_id').on(t.id),
    statusCheck: check(
      'spike_jobs_status_check',
      sql`${t.status} in ('created','queued','running','retry_wait','succeeded','partially_succeeded','failed','cancelled')`,
    ),
    kindCheck: check(
      'spike_jobs_kind_check',
      sql`${t.kind} in ('source_ingestion','assessment_generation','question_regeneration','export_pdf')`,
    ),
  }),
);

export const jobAttempts = pgTable('spike_job_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull(),
  attempt: integer('attempt').notNull(),
  workerId: text('worker_id').notNull(),
  outcome: text('outcome').notNull(),
  redactedDetail: jsonb('redacted_detail'),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

export const idempotencyKeys = pgTable(
  'spike_idempotency_keys',
  {
    key: text('key').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    operation: text('operation').notNull(),
    jobId: uuid('job_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    scopeUnique: uniqueIndex('spike_idempotency_scope').on(t.workspaceId, t.operation, t.key),
  }),
);

export const outboxEvents = pgTable('spike_outbox_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  aggregate: text('aggregate').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

export type SpikeJob = typeof jobs.$inferSelect;
export type NewSpikeJob = typeof jobs.$inferInsert;
export type SpikeJobAttempt = typeof jobAttempts.$inferSelect;
export type SpikeIdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type SpikeOutboxEvent = typeof outboxEvents.$inferSelect;
