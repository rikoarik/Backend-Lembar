/**
 * Quota reservation ledger schema (B2-04).
 *
 * Append-only ledger tracking quota reservation lifecycle:
 * reserve -> commit -> release, linked to generation job IDs.
 *
 * Invariants:
 * - One reservation per idempotency key (deduplication)
 * - Balance = reserved - committed - released per workspace
 * - Tenant isolation via tenant_id foreign key
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from '../../../infrastructure/database/schema.js';

export const RESERVATION_STATES = ['reserved', 'committed', 'released'] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

export const quotaReservations = pgTable(
  'quota_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    jobId: uuid('job_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    units: integer('units').notNull(),
    state: text('state').$type<ReservationState>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    committedAt: timestamp('committed_at', { withTimezone: true, mode: 'date' }),
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    idempotencyUnique: uniqueIndex('quota_reservations_idempotency_unique').on(
      t.tenantId,
      t.workspaceId,
      t.idempotencyKey,
    ),
    jobIdIdx: index('quota_reservations_job_id_idx').on(t.jobId),
    tenantWorkspaceIdx: index('quota_reservations_tenant_workspace_idx').on(
      t.tenantId,
      t.workspaceId,
    ),
    stateCheck: check(
      'quota_reservations_state_check',
      sql`${t.state} in ('reserved','committed','released')`,
    ),
    unitsPositive: check('quota_reservations_units_positive', sql`${t.units} > 0`),
  }),
);

export type QuotaReservation = typeof quotaReservations.$inferSelect;
export type NewQuotaReservation = typeof quotaReservations.$inferInsert;
