/**
 * Payment domain types (B6-02).
 *
 * Gateway-agnostic payment order and webhook event types.
 * The system is designed to be pluggable — initially supports a mock/manual
 * gateway suitable for testing; real Midtrans/Stripe wiring happens in the
 * adapter layer via environment variables.
 */

// ── Order status state machine ────────────────────────────────────────────────
// pending → paid       (success webhook / manual confirm)
// pending → failed     (failure webhook / timeout)
// pending → cancelled  (explicit cancel)
// paid    → refunded   (refund webhook)
export type PaymentOrderStatus = 'pending' | 'paid' | 'failed' | 'cancelled' | 'refunded';

// ── Plan types (mirrors plans/persistence/schema.ts) ─────────────────────────
export type PaymentPlanType = 'free' | 'pro';

// ── Payment order ─────────────────────────────────────────────────────────────
export interface PaymentOrder {
  id: string;
  tenantId: string;
  workspaceId: string;
  /** Idempotency key — client-generated, prevents duplicate orders */
  idempotencyKey: string;
  /** External order id from the payment gateway (e.g. Midtrans order_id) */
  externalOrderId: string | null;
  fromPlan: PaymentPlanType;
  toPlan: PaymentPlanType;
  amountCents: number;
  currency: string;
  status: PaymentOrderStatus;
  /** Raw gateway payload stored for reconciliation */
  gatewayPayload: Record<string, unknown> | null;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewPaymentOrder = Omit<PaymentOrder, 'id' | 'createdAt' | 'updatedAt'>;

// ── Payment event (immutable audit log) ──────────────────────────────────────
export type PaymentEventType =
  | 'order_created'
  | 'order_paid'
  | 'order_failed'
  | 'order_cancelled'
  | 'order_refunded'
  | 'webhook_received'
  | 'plan_upgraded'
  | 'plan_downgraded';

export interface PaymentEvent {
  id: string;
  orderId: string;
  tenantId: string;
  workspaceId: string;
  eventType: PaymentEventType;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export type NewPaymentEvent = Omit<PaymentEvent, 'id' | 'createdAt'>;

// ── Service inputs / outputs ──────────────────────────────────────────────────
export interface CreateOrderInput {
  tenantId: string;
  workspaceId: string;
  idempotencyKey: string;
  toPlan: PaymentPlanType;
  amountCents: number;
  currency?: string | undefined;
}


export interface CreateOrderResult {
  order: PaymentOrder;
  /** true if a pre-existing idempotent order was returned instead of created */
  idempotent: boolean;
}

export interface WebhookPayload {
  /** Raw body string for signature verification */
  rawBody: string;
  /** Parsed payload from gateway */
  parsed: Record<string, unknown>;
  /** Signature header value from gateway */
  signature: string | undefined;
  /** Gateway identifier: 'midtrans' | 'stripe' | 'manual' */
  gateway: string;
}

export interface WebhookHandleResult {
  orderId: string;
  newStatus: PaymentOrderStatus;
  planTransitioned: boolean;
}

export interface PlanChangeInput {
  tenantId: string;
  workspaceId: string;
  actorId: string;
  targetPlan: PaymentPlanType;
  /** Optional pre-existing paid order that authorises this upgrade */
  orderId?: string | undefined;
}

export interface PlanChangeResult {
  workspaceId: string;
  previousPlan: PaymentPlanType;
  newPlan: PaymentPlanType;
  orderId: string | null;
  transitionedAt: string;
}
