/**
 * B8-02 — Data lifecycle schema
 *
 * - account_delete_schedule: antrian soft→hard delete dengan retention window
 * - account_tombstones: immutable audit trail setelah hard-delete
 */
import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// ── Delete schedule (deferred hard-delete queue) ──────────────────────────────

export const accountDeleteSchedule = pgTable('account_delete_schedule', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull(),
  scheduledBy: uuid('scheduled_by').notNull(),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  purgeAfter: timestamp('purge_after', { withTimezone: true, mode: 'date' }).notNull(),
  retentionDays: integer('retention_days').notNull().default(30),
  reason: text('reason'),
  status: text('status').notNull().default('pending'),
  executedAt: timestamp('executed_at', { withTimezone: true, mode: 'date' }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

export type AccountDeleteSchedule = typeof accountDeleteSchedule.$inferSelect;
export type NewAccountDeleteSchedule = typeof accountDeleteSchedule.$inferInsert;

// ── Tombstone (immutable audit trail) ─────────────────────────────────────────

export const accountTombstones = pgTable('account_tombstones', {
  id: uuid('id').primaryKey().defaultRandom(),
  originalId: uuid('original_id').notNull().unique(),
  emailHash: text('email_hash').notNull(),
  roles: text('roles').array().notNull().default(sql`'{}'`),
  tenantId: uuid('tenant_id'),
  workspaceId: uuid('workspace_id'),
  deletedBy: uuid('deleted_by').notNull(),
  deleteReason: text('delete_reason'),
  snapshot: jsonb('snapshot').notNull().default(sql`'{}'`),
  retentionDays: integer('retention_days').notNull().default(30),
  purgedAt: timestamp('purged_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

export type AccountTombstone = typeof accountTombstones.$inferSelect;
export type NewAccountTombstone = typeof accountTombstones.$inferInsert;

// ── Status constants ──────────────────────────────────────────────────────────

export const DELETE_SCHEDULE_STATUS = {
  PENDING: 'pending',
  EXECUTED: 'executed',
  CANCELLED: 'cancelled',
} as const;

export type DeleteScheduleStatus =
  (typeof DELETE_SCHEDULE_STATUS)[keyof typeof DELETE_SCHEDULE_STATUS];

export const DEFAULT_RETENTION_DAYS = 30;
