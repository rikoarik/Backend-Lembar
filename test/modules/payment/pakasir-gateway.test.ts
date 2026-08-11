import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerWebhookRoutes } from '../../../src/modules/payment/adapters/http/webhookRoutes.js';
import { PaymentService } from '../../../src/modules/payment/application/PaymentService.js';

const service = () => new PaymentService({} as never, {} as never, { pakasirApiKey: 'key' });

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

  it('fails closed before processing an unverifiable Pakasir callback', async () => {
    const payment = service();
    await expect(
      payment.handleWebhook({
        gateway: 'pakasir',
        parsed: { order_id: 'order-1', status: 'completed', amount: 49000 },
        rawBody: '{}',
        signature: undefined,
      }),
    ).rejects.toThrow('pakasir-verification-unavailable');
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
      payload: { order_id: 'order-1', status: 'completed', amount: 99000 },
    });

    expect(response.statusCode).toBe(200);
    expect(handleWebhook).toHaveBeenCalledWith(expect.objectContaining({ gateway: 'pakasir' }));
    await app.close();
  });
});
