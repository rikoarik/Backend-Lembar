/**
 * Payment webhook HTTP routes (B6-02).
 *
 * POST /v1/payment/webhook        — receive gateway callbacks (Midtrans/Stripe/manual)
 * POST /v1/payment/orders         — create a new payment order (idempotent)
 * GET  /v1/payment/orders         — list orders for a workspace
 * GET  /v1/payment/orders/:id/events — audit log for an order
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import type { PaymentService } from '../../application/PaymentService.js';
import {
  OrderNotFoundError,
  InvalidOrderTransitionError,
  WebhookSignatureError,
} from '../../domain/errors.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'req_unknown';
}

function handleError(err: unknown, req: FastifyRequest, reply: FastifyReply): void {
  const requestId = getRequestId(req);

  if (err instanceof WebhookSignatureError) {
    void reply.status(401).send({
      error: { code: 'WEBHOOK_SIGNATURE_INVALID', message: err.message, requestId, retryable: false },
    });
    return;
  }
  if (err instanceof OrderNotFoundError) {
    void reply.status(404).send({
      error: { code: 'ORDER_NOT_FOUND', message: err.message, requestId, retryable: false },
    });
    return;
  }
  if (err instanceof InvalidOrderTransitionError) {
    void reply.status(409).send({
      error: { code: 'INVALID_ORDER_TRANSITION', message: err.message, requestId, retryable: false },
    });
    return;
  }
  void reply.status(500).send({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId, retryable: false },
  });
}

export interface RegisterWebhookRoutesOptions {
  paymentService: PaymentService;
}

export async function registerWebhookRoutes(
  app: FastifyInstance,
  options: RegisterWebhookRoutesOptions,
): Promise<void> {
  const { paymentService } = options;

  /**
   * POST /v1/payment/webhook
   *
   * Receives payment gateway callbacks. Supports Midtrans, Stripe, and
   * a 'manual' gateway for test/admin use.
   *
   * Headers:
   *   x-gateway          — 'midtrans' | 'stripe' | 'manual' (default: 'manual')
   *   x-hub-signature    — Midtrans signature header (optional)
   *   stripe-signature   — Stripe signature header (optional)
   */
  app.post('/v1/payment/webhook', async (request: FastifyRequest, reply: FastifyReply) => {
    const gateway = (request.headers['x-gateway'] as string | undefined) ?? 'manual';
    const signature =
      (request.headers['stripe-signature'] as string | undefined) ??
      (request.headers['x-hub-signature'] as string | undefined);
    const rawBody = JSON.stringify(request.body);
    const parsed = (request.body as Record<string, unknown>) ?? {};

    try {
      const result = await paymentService.handleWebhook({
        rawBody,
        parsed,
        signature,
        gateway,
      });
      return reply.status(200).send({ data: result });
    } catch (err) {
      handleError(err, request, reply);
    }
  });

  /**
   * POST /v1/payment/orders
   *
   * Create a new payment order (idempotent via x-idempotency-key header).
   *
   * Headers: x-tenant-id, x-workspace-id, x-idempotency-key
   * Body: { toPlan: 'pro', amountCents: number, currency?: string }
   */
  app.post('/v1/payment/orders', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = getRequestId(request);
    const tenantId = request.headers['x-tenant-id'] as string | undefined;
    const workspaceId = request.headers['x-workspace-id'] as string | undefined;
    const idempotencyKey = request.headers['x-idempotency-key'] as string | undefined;

    if (!tenantId || !workspaceId || !idempotencyKey) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Missing required headers: x-tenant-id, x-workspace-id, x-idempotency-key',
          requestId,
          retryable: false,
        },
      });
    }

    const body = request.body as Record<string, unknown>;
    const toPlan = body['toPlan'] as string | undefined;
    const amountCents = body['amountCents'] as number | undefined;

    if (!toPlan || amountCents === undefined) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Body must include toPlan and amountCents',
          requestId,
          retryable: false,
        },
      });
    }

    if (toPlan !== 'pro' && toPlan !== 'free') {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'toPlan must be "pro" or "free"',
          requestId,
          retryable: false,
        },
      });
    }

    try {
      const result = await paymentService.createOrder({
        tenantId,
        workspaceId,
        idempotencyKey,
        toPlan,
        amountCents,
        currency: body['currency'] as string | undefined,
      });

      const status = result.idempotent ? 200 : 201;
      return reply.status(status).send({ data: result });
    } catch (err) {
      handleError(err, request, reply);
    }
  });

  /**
   * GET /v1/payment/orders
   *
   * List all payment orders for a workspace (reconciliation).
   * Headers: x-tenant-id, x-workspace-id
   */
  app.get('/v1/payment/orders', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = getRequestId(request);
    const tenantId = request.headers['x-tenant-id'] as string | undefined;
    const workspaceId = request.headers['x-workspace-id'] as string | undefined;

    if (!tenantId || !workspaceId) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Missing required headers: x-tenant-id, x-workspace-id',
          requestId,
          retryable: false,
        },
      });
    }

    try {
      const orders = await paymentService.listOrders(tenantId, workspaceId);
      return reply.status(200).send({ data: orders });
    } catch (err) {
      handleError(err, request, reply);
    }
  });

  /**
   * GET /v1/payment/orders/:id/events
   *
   * Immutable audit log for a specific order.
   */
  app.get('/v1/payment/orders/:id/events', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { id: string };
    const orderId = params.id;

    try {
      const events = await paymentService.getOrderEvents(orderId);
      return reply.status(200).send({ data: events });
    } catch (err) {
      handleError(err, request, reply);
    }
  });
}
