/**
 * B6-02 Payment Integration Tests (vitest)
 *
 * Tests cover:
 *   - Idempotent order creation (same key → same order, no duplicate)
 *   - Webhook handler: manual gateway paid → plan upgraded
 *   - Webhook handler: duplicate webhook → idempotent (no double transition)
 *   - Webhook handler: unknown order → OrderNotFoundError
 *   - Invalid state transition (failed → paid) → InvalidOrderTransitionError
 *   - Webhook handler: Midtrans settlement → paid
 *   - Webhook handler: Midtrans expire → cancelled
 *   - WebhookSignatureError when key set but signature missing
 *   - Plan upgrade: free → pro
 *   - Plan upgrade: no-op when already pro
 *   - Plan upgrade: throws when targetPlan=free
 *   - Plan downgrade: pro → free
 *   - Plan downgrade: throws when targetPlan=pro
 *   - listOrders: returns all orders for workspace
 */
import { describe, it, expect } from 'vitest';

import { PaymentService } from '../../../src/modules/payment/application/PaymentService.js';
import { PaymentRepository } from '../../../src/modules/payment/persistence/repository.js';
import {
  OrderNotFoundError,
  InvalidOrderTransitionError,
  WebhookSignatureError,
  InvalidPlanTransitionError,
} from '../../../src/modules/payment/domain/errors.js';
import type { PaymentOrderRow } from '../../../src/modules/payment/persistence/schema.js';
import type { PaymentOrderStatus, PaymentPlanType } from '../../../src/modules/payment/domain/types.js';

// ── In-memory stubs ──────────────────────────────────────────────────────────

type OrderStore = Map<string, PaymentOrderRow>;
type EventStore = Array<{
  id: string;
  orderId: string;
  tenantId: string;
  workspaceId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}>;

function makeOrderRow(overrides: Partial<PaymentOrderRow> = {}): PaymentOrderRow {
  return {
    id: `order-${Math.random().toString(36).slice(2)}`,
    tenantId: 'tenant-1',
    workspaceId: 'ws-1',
    idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
    externalOrderId: null,
    fromPlan: 'free',
    toPlan: 'pro',
    amountCents: 50000,
    currency: 'IDR',
    status: 'pending',
    gatewayPayload: null,
    paidAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function stubPaymentRepo(orders: OrderStore, events: EventStore): PaymentRepository {
  return {
    findByIdempotencyKey: async (key: string) =>
      Array.from(orders.values()).find((o) => o.idempotencyKey === key) ?? null,
    findById: async (id: string) => orders.get(id) ?? null,
    findByExternalOrderId: async (extId: string) =>
      Array.from(orders.values()).find((o) => o.externalOrderId === extId) ?? null,
    listByWorkspace: async (tenantId: string, workspaceId: string) =>
      Array.from(orders.values()).filter(
        (o) => o.tenantId === tenantId && o.workspaceId === workspaceId,
      ),
    createOrder: async (data: Partial<PaymentOrderRow>) => {
      const row = makeOrderRow(data);
      orders.set(row.id, row);
      return row;
    },
    updateOrderStatus: async (
      id: string,
      status: PaymentOrderStatus,
      opts?: { paidAt?: Date; gatewayPayload?: Record<string, unknown>; externalOrderId?: string },
    ) => {
      const row = orders.get(id);
      if (!row) throw new Error(`Order ${id} not found`);
      const updated: PaymentOrderRow = {
        ...row,
        status,
        updatedAt: new Date(),
        paidAt: opts?.paidAt ?? row.paidAt,
        gatewayPayload: opts?.gatewayPayload ?? row.gatewayPayload,
        externalOrderId: opts?.externalOrderId ?? row.externalOrderId,
      };
      orders.set(id, updated);
      return updated;
    },
    appendEvent: async (data: {
      orderId: string;
      tenantId: string;
      workspaceId: string;
      eventType: string;
      payload: unknown;
    }) => {
      const ev = {
        id: `evt-${Math.random().toString(36).slice(2)}`,
        orderId: data.orderId,
        tenantId: data.tenantId,
        workspaceId: data.workspaceId,
        eventType: data.eventType,
        payload: data.payload as Record<string, unknown>,
        createdAt: new Date(),
      };
      events.push(ev);
      return ev;
    },
    listEventsByOrder: async (orderId: string) =>
      events.filter((e) => e.orderId === orderId),
  } as unknown as PaymentRepository;
}

type PlanStore = Map<string, string>;

function stubPlanRepo(plans: PlanStore) {
  return {
    findOrCreate: async (tenantId: string, workspaceId: string) => {
      const key = `${tenantId}:${workspaceId}`;
      const plan = plans.get(key) ?? 'free';
      return {
        id: `plan-${key}`,
        tenantId,
        workspaceId,
        plan,
        generationsUsedThisMonth: 0,
        billingCycleStartedAt: new Date(),
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        monthlyGenerationLimit: 10,
      };
    },
    setPlan: async (tenantId: string, workspaceId: string, newPlan: string) => {
      const key = `${tenantId}:${workspaceId}`;
      plans.set(key, newPlan);
      return {
        id: `plan-${key}`,
        tenantId,
        workspaceId,
        plan: newPlan,
        generationsUsedThisMonth: 0,
        billingCycleStartedAt: new Date(),
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        monthlyGenerationLimit: null,
      };
    },
    hasQuota: async () => true,
    incrementUsage: async () => {},
  };
}

function makeService(opts: { midtransKey?: string } = {}) {
  const orders: OrderStore = new Map();
  const events: EventStore = [];
  const plans: PlanStore = new Map();
  const paymentRepo = stubPaymentRepo(orders, events);
  const planRepo = stubPlanRepo(plans);
  const svcOpts: { midtransServerKey?: string | undefined } = {};
  if (opts.midtransKey !== undefined) svcOpts.midtransServerKey = opts.midtransKey;
  const svc = new PaymentService(paymentRepo, planRepo as never, svcOpts);
  return { svc, orders, events, plans };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PaymentService — createOrder', () => {
  it('creates a new order with status=pending', async () => {
    const { svc } = makeService();
    const result = await svc.createOrder({
      tenantId: 'tenant-1', workspaceId: 'ws-1',
      idempotencyKey: 'key-abc', toPlan: 'pro', amountCents: 50000,
    });
    expect(result.idempotent).toBe(false);
    expect(result.order.status).toBe('pending');
    expect(result.order.toPlan).toBe('pro');
    expect(result.order.amountCents).toBe(50000);
    expect(result.order.currency).toBe('IDR');
  });

  it('returns same order for duplicate idempotency key (idempotent=true)', async () => {
    const { svc } = makeService();
    const input = { tenantId: 'tenant-1', workspaceId: 'ws-1', idempotencyKey: 'key-idem', toPlan: 'pro' as PaymentPlanType, amountCents: 50000 };
    const first = await svc.createOrder(input);
    const second = await svc.createOrder(input);
    expect(second.idempotent).toBe(true);
    expect(second.order.id).toBe(first.order.id);
  });

  it('appends order_created event', async () => {
    const { svc, events } = makeService();
    await svc.createOrder({ tenantId: 'tenant-1', workspaceId: 'ws-1', idempotencyKey: 'key-ev', toPlan: 'pro', amountCents: 50000 });
    expect(events.some((e) => e.eventType === 'order_created')).toBe(true);
  });
});

describe('PaymentService — handleWebhook (manual gateway)', () => {
  it('transitions pending → paid and upgrades plan', async () => {
    const { svc, plans } = makeService();
    const { order } = await svc.createOrder({ tenantId: 'tenant-1', workspaceId: 'ws-1', idempotencyKey: 'key-wh1', toPlan: 'pro', amountCents: 50000 });
    const result = await svc.handleWebhook({ rawBody: '{}', parsed: { order_id: order.id, status: 'paid' }, signature: undefined, gateway: 'manual' });
    expect(result.newStatus).toBe('paid');
    expect(result.planTransitioned).toBe(true);
    expect(plans.get('tenant-1:ws-1')).toBe('pro');
  });

  it('is idempotent — duplicate webhook adds only webhook_received event', async () => {
    const { svc, events } = makeService();
    const { order } = await svc.createOrder({ tenantId: 'tenant-1', workspaceId: 'ws-1', idempotencyKey: 'key-idem-wh', toPlan: 'pro', amountCents: 50000 });
    const wh = { rawBody: '{}', parsed: { order_id: order.id, status: 'paid' }, signature: undefined as string | undefined, gateway: 'manual' };
    await svc.handleWebhook(wh);
    const countAfterFirst = events.length;
    await svc.handleWebhook(wh);
    const newEvents = events.slice(countAfterFirst);
    expect(newEvents.every((e) => e.eventType === 'webhook_received')).toBe(true);
  });

  it('throws OrderNotFoundError for unknown external order id', async () => {
    const { svc } = makeService();
    await expect(svc.handleWebhook({ rawBody: '{}', parsed: { order_id: 'does-not-exist', status: 'paid' }, signature: undefined, gateway: 'manual' })).rejects.toBeInstanceOf(OrderNotFoundError);
  });

  it('throws InvalidOrderTransitionError for failed → paid', async () => {
    const { svc } = makeService();
    const { order } = await svc.createOrder({ tenantId: 'tenant-1', workspaceId: 'ws-1', idempotencyKey: 'key-bad', toPlan: 'pro', amountCents: 50000 });
    await svc.handleWebhook({ rawBody: '{}', parsed: { order_id: order.id, status: 'failed' }, signature: undefined, gateway: 'manual' });
    await expect(svc.handleWebhook({ rawBody: '{}', parsed: { order_id: order.id, status: 'paid' }, signature: undefined, gateway: 'manual' })).rejects.toBeInstanceOf(InvalidOrderTransitionError);
  });
});

describe('PaymentService — handleWebhook (Midtrans)', () => {
  it('resolves settlement → paid', async () => {
    const { svc } = makeService();
    const { order } = await svc.createOrder({ tenantId: 'tenant-1', workspaceId: 'ws-1', idempotencyKey: 'key-midtrans', toPlan: 'pro', amountCents: 50000 });
    const result = await svc.handleWebhook({ rawBody: '{}', parsed: { order_id: order.id, transaction_status: 'settlement', fraud_status: 'accept' }, signature: undefined, gateway: 'midtrans' });
    expect(result.newStatus).toBe('paid');
  });

  it('resolves expire → cancelled', async () => {
    const { svc } = makeService();
    const { order } = await svc.createOrder({ tenantId: 'tenant-1', workspaceId: 'ws-1', idempotencyKey: 'key-expire', toPlan: 'pro', amountCents: 50000 });
    const result = await svc.handleWebhook({ rawBody: '{}', parsed: { order_id: order.id, transaction_status: 'expire' }, signature: undefined, gateway: 'midtrans' });
    expect(result.newStatus).toBe('cancelled');
  });

  it('throws WebhookSignatureError when key configured but signature missing', async () => {
    const { svc } = makeService({ midtransKey: 'secret' });
    const { order } = await svc.createOrder({ tenantId: 'tenant-1', workspaceId: 'ws-1', idempotencyKey: 'key-sig', toPlan: 'pro', amountCents: 50000 });
    await expect(svc.handleWebhook({ rawBody: '{}', parsed: { order_id: order.id, transaction_status: 'settlement' }, signature: undefined, gateway: 'midtrans' })).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});

describe('PaymentService — upgradePlan', () => {
  it('rejects upgrade without a paid order', async () => {
    const { svc } = makeService();
    await expect(
      svc.upgradePlan({ tenantId: 'tenant-1', workspaceId: 'ws-1', actorId: 'admin', targetPlan: 'pro' }),
    ).rejects.toBeInstanceOf(InvalidPlanTransitionError);
  });

  it('is no-op when already on pro', async () => {
    const { svc, plans } = makeService();
    plans.set('tenant-1:ws-1', 'pro');
    const result = await svc.upgradePlan({ tenantId: 'tenant-1', workspaceId: 'ws-1', actorId: 'admin', targetPlan: 'pro' });
    expect(result.previousPlan).toBe('pro');
    expect(result.newPlan).toBe('pro');
  });

  it('throws InvalidPlanTransitionError when targetPlan=free', async () => {
    const { svc } = makeService();
    await expect(svc.upgradePlan({ tenantId: 'tenant-1', workspaceId: 'ws-1', actorId: 'admin', targetPlan: 'free' as PaymentPlanType })).rejects.toBeInstanceOf(InvalidPlanTransitionError);
  });
});

describe('PaymentService — downgradePlan', () => {
  it('transitions pro → free', async () => {
    const { svc, plans } = makeService();
    plans.set('tenant-1:ws-1', 'pro');
    const result = await svc.downgradePlan({ tenantId: 'tenant-1', workspaceId: 'ws-1', actorId: 'admin', targetPlan: 'free' });
    expect(result.previousPlan).toBe('pro');
    expect(result.newPlan).toBe('free');
    expect(plans.get('tenant-1:ws-1')).toBe('free');
  });

  it('throws InvalidPlanTransitionError when targetPlan=pro', async () => {
    const { svc } = makeService();
    await expect(svc.downgradePlan({ tenantId: 'tenant-1', workspaceId: 'ws-1', actorId: 'admin', targetPlan: 'pro' as PaymentPlanType })).rejects.toBeInstanceOf(InvalidPlanTransitionError);
  });
});

describe('PaymentService — listOrders', () => {
  it('returns all orders for a workspace', async () => {
    const { svc } = makeService();
    await svc.createOrder({ tenantId: 'tenant-1', workspaceId: 'ws-1', idempotencyKey: 'k1', toPlan: 'pro', amountCents: 50000 });
    await svc.createOrder({ tenantId: 'tenant-1', workspaceId: 'ws-1', idempotencyKey: 'k2', toPlan: 'pro', amountCents: 50000 });
    const orders = await svc.listOrders('tenant-1', 'ws-1');
    expect(orders).toHaveLength(2);
  });
});
