import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerWebhookRoutes } from '../../../src/modules/payment/adapters/http/webhookRoutes.js';
import { PaymentService } from '../../../src/modules/payment/application/PaymentService.js';

const service = () => {
  const paymentRepo = {
    findByExternalOrderId: async () => ({
      id: 'order-1',
      tenantId: 'tenant-1',
      workspaceId: 'workspace-1',
      idempotencyKey: 'idem-1',
      externalOrderId: 'order-1',
      fromPlan: 'free',
      toPlan: 'pro',
      amountCents: 49000,
      currency: 'IDR',
      status: 'pending',
      gatewayPayload: null,
      paidAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    findById: async () => null,
    appendEvent: async () => undefined,
    transaction: async (fn: (repo: typeof paymentRepo, db: never) => Promise<unknown>) =>
      fn(paymentRepo, {} as never),
    transitionOrderIfCurrent: async () => ({
      id: 'order-1',
      tenantId: 'tenant-1',
      workspaceId: 'workspace-1',
      idempotencyKey: 'idem-1',
      externalOrderId: 'order-1',
      fromPlan: 'free',
      toPlan: 'pro',
      amountCents: 49000,
      currency: 'IDR',
      status: 'paid',
      gatewayPayload: { status: 'completed' },
      paidAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    createOrderIfAbsent: async () => ({ row: {} as never, created: true }),
    listByWorkspace: async () => [],
    listEventsByOrder: async () => [],
  } as never;

  const planRepo = {
    findOrCreate: async () => ({ plan: 'free' }),
    setPlan: async () => undefined,
    withDatabase: () => ({ findOrCreate: async () => ({ plan: 'free' }), setPlan: async () => undefined }) as never,
  } as never;

  return new PaymentService(paymentRepo, planRepo, { pakasirApiKey: 'key' });
};

describe('Pakasir gateway', () => {
  afterEach(() => delete process.env['PAKASIR_API_KEY']);

  it.each([
    ['completed', 'paid'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ])('maps %s webhook status to %s', (status, expected) => {
    const payment = service() as unknown as {
      resolveWebhookStatus(parsed: Record<string, unknown>, gateway: string): string;
    };
    expect(payment.resolveWebhookStatus({ status }, 'pakasir')).toBe(expected);
  });

  it('marks completed Pakasir callbacks as paid', async () => {
    const payment = service();
    const result = await payment.handleWebhook({
      gateway: 'pakasir',
      parsed: { order_id: 'order-1', status: 'completed', amount: 49000, project: 'lembar-app' },
      rawBody: '{}',
      signature: undefined,
    });
    expect(result.newStatus).toBe('paid');
    expect(result.planTransitioned).toBe(true);
  });

  it('accepts x-gateway pakasir', async () => {
    process.env['PAKASIR_API_KEY'] = 'key';
    const app = Fastify();
    const handleWebhook = vi
      .fn()
      .mockResolvedValue({ orderId: 'order-1', newStatus: 'paid', planTransitioned: true });
    await registerWebhookRoutes(app, {
      paymentService: { handleWebhook } as never,
      db: {} as never,
      jwtSecret: 'secret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/payment/webhook',
      headers: { 'x-gateway': 'pakasir' },
      payload: {
        transaction: { order_id: 'order-1', status: 'completed', amount: 99000, project: 'lembar-app' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(handleWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: 'pakasir',
        parsed: expect.objectContaining({
          order_id: 'order-1',
          amount: 99000,
          status: 'completed',
          project: 'lembar-app',
        }),
      }),
    );
    await app.close();
  });
});
