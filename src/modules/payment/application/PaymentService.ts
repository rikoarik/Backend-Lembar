/**
 * PaymentService — application layer (B6-02).
 *
 * Responsibilities:
 *   - Idempotent order creation (same idempotency key → same order returned)
 *   - Webhook handling with HMAC-SHA256 signature verification
 *   - Subscription state machine: pending → paid → plan upgraded
 *   - Plan upgrade/downgrade flow coordinated with PlanService
 *   - Reconciliation: list orders + events for a workspace
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { PaymentRepository } from '../persistence/repository.js';
import type { WorkspacePlanRepository } from '../../plans/persistence/repository.js';
import {
  DuplicateOrderError,
  OrderNotFoundError,
  InvalidOrderTransitionError,
  WebhookSignatureError,
  InvalidPlanTransitionError,
} from '../domain/errors.js';
import type {
  CreateOrderInput,
  CreateOrderResult,
  WebhookPayload,
  WebhookHandleResult,
  PlanChangeInput,
  PlanChangeResult,
  PaymentOrder,
  PaymentOrderStatus,
  PaymentPlanType,
} from '../domain/types.js';
import type { PaymentOrderRow } from '../persistence/schema.js';

// ── Valid status transitions ──────────────────────────────────────────────────
const ALLOWED_TRANSITIONS: Record<PaymentOrderStatus, PaymentOrderStatus[]> = {
  pending: ['paid', 'failed', 'cancelled'],
  paid: ['refunded'],
  failed: [],
  cancelled: [],
  refunded: [],
};

function isTransitionAllowed(from: PaymentOrderStatus, to: PaymentOrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

function rowToOrder(row: PaymentOrderRow): PaymentOrder {
  return {
    id: row.id,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    idempotencyKey: row.idempotencyKey,
    externalOrderId: row.externalOrderId ?? null,
    fromPlan: (row.fromPlan as PaymentPlanType) ?? 'free',
    toPlan: row.toPlan as PaymentPlanType,
    amountCents: row.amountCents,
    currency: row.currency,
    status: row.status as PaymentOrderStatus,
    gatewayPayload: (row.gatewayPayload as Record<string, unknown>) ?? null,
    paidAt: row.paidAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface PaymentServiceOptions {
  /** HMAC-SHA256 secret for Midtrans server key (optional — disabled if absent) */
  midtransServerKey?: string | undefined;
  /** HMAC-SHA256 secret for Stripe webhook (optional — disabled if absent) */
  stripeWebhookSecret?: string | undefined;
  pakasirApiKey?: string | undefined;
  pakasirProjectSlug?: string | undefined;
}

export class PaymentService {
  constructor(
    private readonly paymentRepo: PaymentRepository,
    private readonly planRepo: WorkspacePlanRepository,
    private readonly opts: PaymentServiceOptions = {},
  ) {}

  // ── Order creation (idempotent) ──────────────────────────────────────────

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    // Check idempotency — return existing order if key already used
    const existing = await this.paymentRepo.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return { order: rowToOrder(existing), idempotent: true };
    }

    // Get current plan for "from" value
    const currentPlan = await this.planRepo.findOrCreate(input.tenantId, input.workspaceId);

    const row = await this.paymentRepo.createOrder({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      idempotencyKey: input.idempotencyKey,
      externalOrderId: input.externalOrderId ?? null,
      fromPlan: currentPlan.plan,
      toPlan: input.toPlan,
      amountCents: input.amountCents,
      currency: input.currency ?? 'IDR',
      status: 'pending',
      gatewayPayload: null,
      paidAt: null,
    });

    await this.paymentRepo.appendEvent({
      orderId: row.id,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      eventType: 'order_created',
      payload: {
        toPlan: input.toPlan,
        amountCents: input.amountCents,
        currency: input.currency ?? 'IDR',
      },
    });

    return { order: rowToOrder(row), idempotent: false };
  }

  // ── Webhook handler (idempotent) ─────────────────────────────────────────

  async handleWebhook(payload: WebhookPayload): Promise<WebhookHandleResult> {
    // Verify signature when secrets are configured
    this.verifySignature(payload);

    const parsed = payload.parsed;

    // Extract external order id — supports Midtrans and Stripe conventions
    const externalOrderId =
      (parsed['order_id'] as string | undefined) ??
      (parsed['id'] as string | undefined) ??
      null;

    if (!externalOrderId) {
      throw new Error('Webhook payload missing order_id / id field');
    }

    // Find order by external id, fallback to internal id
    // (internal id is used for manual gateway and test flows before externalOrderId is set)
    let row = await this.paymentRepo.findByExternalOrderId(externalOrderId);
    if (!row) {
      // Fallback: treat order_id as internal UUID (manual gateway / direct webhook)
      row = await this.paymentRepo.findById(externalOrderId);
    }
    if (!row) {
      throw new OrderNotFoundError(`external:${externalOrderId}`);
    }

    if (payload.gateway === 'midtrans' && this.opts.midtransServerKey) {
      const amount = Number(parsed['gross_amount']);
      if (!Number.isFinite(amount) || amount !== row.amountCents || row.currency !== 'IDR') {
        throw new WebhookSignatureError('midtrans-amount');
      }
    }
    if (payload.gateway === 'stripe' && this.opts.stripeWebhookSecret) {
      const object = (parsed['data'] as { object?: Record<string, unknown> } | undefined)?.object;
      const amount = Number(object?.['amount_received']);
      const currency = String(object?.['currency'] ?? '').toUpperCase();
      if (!Number.isInteger(amount) || amount !== row.amountCents || currency !== row.currency) {
        throw new WebhookSignatureError('stripe-amount');
      }
    }
    if (payload.gateway === 'pakasir') {
      const amount = Number(parsed['amount']);
      if (!Number.isFinite(amount) || amount * 100 !== row.amountCents) {
        throw new WebhookSignatureError('pakasir-amount');
      }
    }

    const currentStatus = row.status as PaymentOrderStatus;

    // Determine new status from gateway payload
    const newStatus = this.resolveWebhookStatus(parsed, payload.gateway);

    // Log webhook regardless of whether we act on it (audit trail)
    await this.paymentRepo.appendEvent({
      orderId: row.id,
      tenantId: row.tenantId,
      workspaceId: row.workspaceId,
      eventType: 'webhook_received',
      payload: { gateway: payload.gateway, rawStatus: newStatus },
    });

    // Idempotent: if already in target status, return early
    if (currentStatus === newStatus) {
      return { orderId: row.id, newStatus, planTransitioned: false };
    }

    // Guard state machine
    if (!isTransitionAllowed(currentStatus, newStatus)) {
      throw new InvalidOrderTransitionError(row.id, currentStatus, newStatus);
    }

    // Transition order
    const statusOpts: { paidAt?: Date; gatewayPayload?: Record<string, unknown> } = {
      gatewayPayload: parsed,
    };
    if (newStatus === 'paid') statusOpts.paidAt = new Date();
    const updatedRow = await this.paymentRepo.updateOrderStatus(row.id, newStatus, statusOpts);

    const eventType =
      newStatus === 'paid' ? 'order_paid' :
      newStatus === 'failed' ? 'order_failed' :
      newStatus === 'cancelled' ? 'order_cancelled' :
      'order_refunded';

    await this.paymentRepo.appendEvent({
      orderId: row.id,
      tenantId: row.tenantId,
      workspaceId: row.workspaceId,
      eventType,
      payload: { previousStatus: currentStatus, newStatus },
    });

    // If order is now paid, upgrade the plan
    let planTransitioned = false;
    if (newStatus === 'paid') {
      await this.transitionPlan({
        tenantId: updatedRow.tenantId,
        workspaceId: updatedRow.workspaceId,
        actorId: 'payment_webhook',
        targetPlan: updatedRow.toPlan as PaymentPlanType,
        orderId: updatedRow.id,
      });
      planTransitioned = true;
    }

    return { orderId: row.id, newStatus, planTransitioned };
  }

  // ── Plan upgrade/downgrade ────────────────────────────────────────────────

  async upgradePlan(input: PlanChangeInput): Promise<PlanChangeResult> {
    if (input.targetPlan === 'free') {
      throw new InvalidPlanTransitionError('any', 'free', 'use downgradePlan instead');
    }
    const current = await this.planRepo.findOrCreate(input.tenantId, input.workspaceId);
    if (current.plan === input.targetPlan) return this.transitionPlan(input);
    if (!input.orderId) {
      throw new InvalidPlanTransitionError('free', input.targetPlan, 'a paid order is required');
    }
    const order = await this.paymentRepo.findById(input.orderId);
    if (!order) throw new OrderNotFoundError(input.orderId);
    if (
      order.tenantId !== input.tenantId ||
      order.workspaceId !== input.workspaceId ||
      order.toPlan !== input.targetPlan
    ) {
      throw new InvalidPlanTransitionError('free', input.targetPlan, 'order does not belong to this plan and workspace');
    }
    if (order.status !== 'paid') {
      throw new InvalidPlanTransitionError('free', input.targetPlan, `order is ${order.status}, not paid`);
    }
    return this.transitionPlan(input);
  }

  async downgradePlan(input: PlanChangeInput): Promise<PlanChangeResult> {
    if (input.targetPlan === 'pro') {
      throw new InvalidPlanTransitionError('any', 'pro', 'use upgradePlan instead');
    }
    return this.transitionPlan(input);
  }

  private async transitionPlan(input: PlanChangeInput): Promise<PlanChangeResult> {
    const current = await this.planRepo.findOrCreate(input.tenantId, input.workspaceId);
    const previousPlan = current.plan as PaymentPlanType;

    if (previousPlan === input.targetPlan) {
      return {
        workspaceId: input.workspaceId,
        previousPlan,
        newPlan: input.targetPlan,
        orderId: input.orderId ?? null,
        transitionedAt: new Date().toISOString(),
      };
    }

    await this.planRepo.setPlan(input.tenantId, input.workspaceId, input.targetPlan);

    const eventType = input.targetPlan === 'pro' ? 'plan_upgraded' : 'plan_downgraded';

    // If we have an associated order, append the event to it
    if (input.orderId) {
      await this.paymentRepo.appendEvent({
        orderId: input.orderId,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        eventType,
        payload: {
          actorId: input.actorId,
          previousPlan,
          newPlan: input.targetPlan,
        },
      });
    }

    return {
      workspaceId: input.workspaceId,
      previousPlan,
      newPlan: input.targetPlan,
      orderId: input.orderId ?? null,
      transitionedAt: new Date().toISOString(),
    };
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  async listOrders(tenantId: string, workspaceId: string): Promise<PaymentOrder[]> {
    const rows = await this.paymentRepo.listByWorkspace(tenantId, workspaceId);
    return rows.map(rowToOrder);
  }

  async getOrderEvents(orderId: string) {
    return this.paymentRepo.listEventsByOrder(orderId);
  }

  async getOrderEventsForWorkspace(orderId: string, tenantId: string, workspaceId: string) {
    const order = await this.paymentRepo.findById(orderId);
    if (!order || order.tenantId !== tenantId || order.workspaceId !== workspaceId) {
      throw new OrderNotFoundError(orderId);
    }
    return this.paymentRepo.listEventsByOrder(orderId);
  }

  // ── Signature verification ────────────────────────────────────────────────

  private verifySignature(payload: WebhookPayload): void {
    const sig = payload.signature;

    if (payload.gateway === 'midtrans') {
      const secret = this.opts.midtransServerKey;
      if (!secret) return;
      if (!sig) throw new WebhookSignatureError('midtrans');

      // Midtrans: SHA512(order_id + status_code + gross_amount + server_key)
      const parsed = payload.parsed;
      const orderId = (parsed['order_id'] as string) ?? '';
      const statusCode = (parsed['status_code'] as string) ?? '';
      const grossAmount = (parsed['gross_amount'] as string) ?? '';
      const expected = createHash('sha512')
        .update(`${orderId}${statusCode}${grossAmount}${secret}`)
        .digest('hex');
      const expectedBuf = Buffer.from(expected, 'utf8');
      const sigBuf = Buffer.from(sig, 'utf8');
      if (expectedBuf.length !== sigBuf.length || !timingSafeEqual(expectedBuf, sigBuf)) {
        throw new WebhookSignatureError('midtrans');
      }
      return;
    }

    if (payload.gateway === 'pakasir') return;

    if (payload.gateway === 'stripe') {
      const secret = this.opts.stripeWebhookSecret;
      if (!secret) return;
      if (!sig) throw new WebhookSignatureError('stripe');

      // Stripe: t=timestamp,v1=hmac — simplified verification
      const parts = sig.split(',');
      const tPart = parts.find((p) => p.startsWith('t='));
      const v1Part = parts.find((p) => p.startsWith('v1='));
      if (!tPart || !v1Part) throw new WebhookSignatureError('stripe');
      const timestamp = tPart.slice(2);
      const timestampSeconds = Number(timestamp);
      if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) {
        throw new WebhookSignatureError('stripe');
      }
      const receivedSig = v1Part.slice(3);
      const expected = createHmac('sha256', secret)
        .update(`${timestamp}.${payload.rawBody}`)
        .digest('hex');
      const expectedBuf = Buffer.from(expected, 'utf8');
      const sigBuf = Buffer.from(receivedSig, 'utf8');
      if (expectedBuf.length !== sigBuf.length || !timingSafeEqual(expectedBuf, sigBuf)) {
        throw new WebhookSignatureError('stripe');
      }
      return;
    }

    // `manual` is retained only for service-level tests; the HTTP route rejects it.
  }

  private resolveWebhookStatus(
    parsed: Record<string, unknown>,
    gateway: string,
  ): PaymentOrderStatus {
    if (gateway === 'midtrans') {
      const txStatus = parsed['transaction_status'] as string | undefined;
      const fraudStatus = parsed['fraud_status'] as string | undefined;
      if (txStatus === 'capture' && fraudStatus === 'accept') return 'paid';
      if (txStatus === 'settlement') return 'paid';
      if (txStatus === 'cancel' || txStatus === 'expire') return 'cancelled';
      if (txStatus === 'deny') return 'failed';
      if (txStatus === 'refund') return 'refunded';
      return 'failed';
    }

    if (gateway === 'stripe') {
      const eventType = parsed['type'] as string | undefined;
      if (eventType === 'payment_intent.succeeded') return 'paid';
      if (eventType === 'payment_intent.payment_failed') return 'failed';
      if (eventType === 'charge.refunded') return 'refunded';
      return 'failed';
    }

    if (gateway === 'pakasir') {
      const status = parsed['status'] as string | undefined;
      if (status === 'completed') return 'paid';
      if (status === 'failed') return 'failed';
      if (status === 'cancelled' || status === 'expired') return 'cancelled';
      return 'failed';
    }

    // manual / test gateway
    const status = parsed['status'] as string | undefined;
    if (status === 'paid') return 'paid';
    if (status === 'failed') return 'failed';
    if (status === 'cancelled') return 'cancelled';
    if (status === 'refunded') return 'refunded';
    return 'failed';
  }
}
