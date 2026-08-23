/**
 * Payment persistence schema (B6-02).
 *
 * Tables:
 *   payment_orders  — one row per checkout attempt, idempotency-keyed
 *   payment_events  — immutable audit log of every status transition
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ── payment_orders ────────────────────────────────────────────────────────────
export const paymentOrders = pgTable(
  'payment_orders',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    /** Client-generated key — enforces at-most-once order creation per intent */
    idempotencyKey: text('idempotency_key').notNull(),
    /** External order id from the payment gateway */
    externalOrderId: text('external_order_id'),
    fromPlan: text('from_plan').notNull().default('free'),
    toPlan: text('to_plan').notNull(),
    /** Amount in smallest currency unit (e.g. cents / IDR sen) */
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('IDR'),
    status: text('status').notNull().default('pending'),
    /** Raw gateway response stored for reconciliation — never logged */
    gatewayPayload: jsonb('gateway_payload'),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    idempotencyUnique: uniqueIndex('payment_orders_idempotency_key_unique').on(t.idempotencyKey),
    workspaceIdx: index('payment_orders_workspace_idx').on(t.tenantId, t.workspaceId),
    externalOrderIdx: index('payment_orders_external_order_idx').on(t.externalOrderId),
    statusCheck: check(
      'payment_orders_status_check',
      sql`${t.status} in ('pending','paid','failed','cancelled','refunded')`,
    ),
    planCheck: check(
      'payment_orders_plan_check',
      sql`${t.fromPlan} in ('free','pro','plus') and ${t.toPlan} in ('free','pro','plus')`,
    ),
    amountCheck: check('payment_orders_amount_non_negative', sql`${t.amountCents} >= 0`),
  }),
);

// ── payment_events ────────────────────────────────────────────────────────────
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orderId: uuid('order_id').notNull(),
    tenantId: text('tenant_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    orderIdx: index('payment_events_order_idx').on(t.orderId),
    workspaceIdx: index('payment_events_workspace_idx').on(t.tenantId, t.workspaceId),
    eventTypeCheck: check(
      'payment_events_event_type_check',
      sql`${t.eventType} in ('order_created','order_paid','order_failed','order_cancelled','order_refunded','webhook_received','plan_upgraded','plan_downgraded')`,
    ),
  }),
);

export type PaymentOrderRow = typeof paymentOrders.$inferSelect;
export type NewPaymentOrderRow = typeof paymentOrders.$inferInsert;
export type PaymentEventRow = typeof paymentEvents.$inferSelect;
export type NewPaymentEventRow = typeof paymentEvents.$inferInsert;
