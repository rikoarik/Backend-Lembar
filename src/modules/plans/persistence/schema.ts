/**
 * Workspace plans schema (B6-01).
 *
 * Tracks plan/entitlement per workspace.
 * Plans: free (10 gen/month) | pro (unlimited).
 *
 * Invariants:
 * - One active plan per workspace at any time
 * - Plan transitions are append-only (audit log)
 * - generationsUsedThisMonth resets each billing cycle
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
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

export const PLAN_TYPES = ['free', 'pro'] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

export const FREE_MONTHLY_LIMIT = 10;

export const workspacePlans = pgTable(
  'workspace_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    plan: text('plan').$type<PlanType>().notNull().default('free'),
    generationsUsedThisMonth: integer('generations_used_this_month').notNull().default(0),
    billingCycleStartedAt: timestamp('billing_cycle_started_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .default(sql`now()`),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    workspaceUnique: uniqueIndex('workspace_plans_workspace_unique').on(
      t.tenantId,
      t.workspaceId,
    ),
    tenantIdx: index('workspace_plans_tenant_idx').on(t.tenantId),
    planCheck: check('workspace_plans_plan_check', sql`${t.plan} in ('free','pro')`),
    usageNonNegative: check(
      'workspace_plans_usage_non_negative',
      sql`${t.generationsUsedThisMonth} >= 0`,
    ),
  }),
);

export type WorkspacePlan = typeof workspacePlans.$inferSelect;
export type NewWorkspacePlan = typeof workspacePlans.$inferInsert;
