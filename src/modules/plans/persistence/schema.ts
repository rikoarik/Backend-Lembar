/**
 * Workspace plans schema (B6-01).
 *
 * Tracks plan/entitlement per workspace.
 * Plans: free | pro | plus — every tier has a finite monthly token limit.
 *
 * Invariants:
 * - One active plan per workspace at any time
 * - Plan transitions are append-only (audit log)
 * - generationsUsedThisMonth resets each billing cycle
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  bigint,
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

export const PLAN_TYPES = ['free', 'pro', 'plus'] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

/**
 * Monthly token limits per tier. Every tier is finite — the product never
 * promises unlimited AI (see PRD). Paid tiers resolve their limit from
 * plan_catalog; these constants are the fail-safe fallbacks when the catalog
 * table is unavailable (tests / no DB).
 */
export const FREE_MONTHLY_TOKEN_LIMIT = 30_000;
export const PRO_MONTHLY_TOKEN_LIMIT = 250_000;
export const PLUS_MONTHLY_TOKEN_LIMIT = 300_000;
/** @deprecated compatibility only. */
export const FREE_MONTHLY_LIMIT = 3;

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
    tokensUsedThisMonth: bigint('tokens_used_this_month', { mode: 'number' }).notNull().default(0),
    tokenMonthlyLimit: bigint('token_monthly_limit', { mode: 'number' }),
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
    planCheck: check('workspace_plans_plan_check', sql`${t.plan} in ('free','pro','plus')`),
    usageNonNegative: check(
      'workspace_plans_usage_non_negative',
      sql`${t.generationsUsedThisMonth} >= 0`,
    ),
  }),
);

export type WorkspacePlan = typeof workspacePlans.$inferSelect;
export type NewWorkspacePlan = typeof workspacePlans.$inferInsert;
