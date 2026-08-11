/**
 * Payment webhook HTTP routes (B6-02).
 *
 * POST /v1/payment/webhook        — receive gateway callbacks (Midtrans/Stripe/manual)
 * POST /v1/payment/orders         — create a new payment order (idempotent)
 * GET  /v1/payment/orders         — list orders for a workspace
 * GET  /v1/payment/orders/:id/events — audit log for an order
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { request as httpsRequest } from 'node:https';

import type { PaymentService } from '../../application/PaymentService.js';
import type { Database } from '../../../../infrastructure/database/db.js';
import { createJwtAuthMiddleware } from '../../../../common/middleware/jwtMultiRoleAuth.js';
import type { PlanCatalogRepository } from '../../../plans/persistence/catalogRepository.js';
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
      error: {
        code: 'WEBHOOK_SIGNATURE_INVALID',
        message: err.message,
        requestId,
        retryable: false,
      },
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
      error: {
        code: 'INVALID_ORDER_TRANSITION',
        message: err.message,
        requestId,
        retryable: false,
      },
    });
    return;
  }
  void reply.status(500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId,
      retryable: false,
    },
  });
}

export interface RegisterWebhookRoutesOptions {
  paymentService: PaymentService;
  db: Database;
  jwtSecret: string;
  catalog?: Pick<PlanCatalogRepository, 'find'>;
}

export async function registerWebhookRoutes(
  app: FastifyInstance,
  options: RegisterWebhookRoutesOptions,
): Promise<void> {
  const { paymentService } = options;
  const auth = createJwtAuthMiddleware({ secret: options.jwtSecret, db: options.db });

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
    const gateway = request.headers['x-gateway'] as string | undefined;
    if (gateway !== 'midtrans' && gateway !== 'stripe' && gateway !== 'pakasir') {
      return reply
        .status(400)
        .send({
          error: {
            code: 'PAYMENT_GATEWAY_INVALID',
            message: 'Gateway tidak didukung.',
            requestId: getRequestId(request),
            retryable: false,
          },
        });
    }
    if (
      (gateway === 'midtrans' && !process.env['MIDTRANS_SERVER_KEY']) ||
      (gateway === 'stripe' && !process.env['STRIPE_WEBHOOK_SECRET']) ||
      (gateway === 'pakasir' && !process.env['PAKASIR_API_KEY'])
    ) {
      return reply
        .status(503)
        .send({
          error: {
            code: 'PAYMENT_NOT_CONFIGURED',
            message: 'Gateway pembayaran belum dikonfigurasi.',
            requestId: getRequestId(request),
            retryable: false,
          },
        });
    }
    const signature =
      (request.headers['stripe-signature'] as string | undefined) ??
      (request.headers['x-hub-signature'] as string | undefined) ??
      ((request.body as Record<string, unknown> | null)?.['signature_key'] as string | undefined);
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
  app.post(
    '/v1/payment/orders',
    { preHandler: [auth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = getRequestId(request);
      const workspaceId = request.jwtUser?.workspaceId;
      const tenantId = workspaceId;
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
      if (!/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
        return reply
          .status(400)
          .send({
            error: {
              code: 'VALIDATION_FAILED',
              message: 'x-idempotency-key tidak valid.',
              requestId,
              retryable: false,
            },
          });
      }

      const body = request.body as Record<string, unknown>;
      const toPlan = body['toPlan'] as string | undefined;
      const amountCents = (await options.catalog?.find('pro'))?.priceAmount;

      if (!toPlan) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Body must include toPlan',
            requestId,
            retryable: false,
          },
        });
      }
      if (!Number.isInteger(amountCents) || (amountCents ?? 0) <= 0) {
        return reply.status(503).send({
          error: {
            code: 'PAYMENT_NOT_CONFIGURED',
            message: 'Harga pembayaran belum dikonfigurasi di server.',
            requestId,
            retryable: false,
          },
        });
      }
      const finalAmountCents = amountCents!;

      if (toPlan !== 'pro') {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'toPlan harus "pro"',
            requestId,
            retryable: false,
          },
        });
      }

      try {
        const result = await paymentService.createOrder({
          tenantId,
          workspaceId,
          idempotencyKey: `${workspaceId}:${idempotencyKey}`,
          toPlan,
          amountCents: finalAmountCents,
          currency: 'IDR',
        });

        const status = result.idempotent ? 200 : 201;
        return reply.status(status).send({ data: result });
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );

  /**
   * GET /v1/payment/orders
   *
   * List all payment orders for a workspace (reconciliation).
   * Headers: x-tenant-id, x-workspace-id
   */
  app.get(
    '/v1/payment/orders',
    { preHandler: [auth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = getRequestId(request);
      const workspaceId = request.jwtUser?.workspaceId;
      const tenantId = workspaceId;

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
    },
  );

  /**
   * GET /v1/payment/orders/:id/events
   *
   * Immutable audit log for a specific order.
   */
  app.get(
    '/v1/payment/orders/:id/events',
    { preHandler: [auth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { id: string };
      const orderId = params.id;
      const workspaceId = request.jwtUser?.workspaceId;
      if (!workspaceId)
        return reply
          .status(403)
          .send({
            error: {
              code: 'PERMISSION_DENIED',
              message: 'Workspace aktif diperlukan.',
              requestId: getRequestId(request),
              retryable: false,
            },
          });

      try {
        const events = await paymentService.getOrderEventsForWorkspace(
          orderId,
          workspaceId,
          workspaceId,
        );
        return reply.status(200).send({ data: events });
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );

  app.post('/v1/payment/pakasir/create-order', { preHandler: [auth] }, async (request, reply) => {
    const requestId = getRequestId(request);
    const workspaceId = request.jwtUser?.workspaceId;
    const body = request.body as Record<string, unknown>;
    const orderId = body['orderId'];
    const toPlan = body['toPlan'];
    const apiKey = process.env['PAKASIR_API_KEY'];
    const slug = process.env['PAKASIR_PROJECT_SLUG'];
    if (!workspaceId || typeof orderId !== 'string' || !orderId || toPlan !== 'pro') {
      return reply
        .status(400)
        .send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'orderId dan toPlan tidak valid.',
            requestId,
            retryable: false,
          },
        });
    }
    if (!apiKey || !slug) {
      return reply
        .status(503)
        .send({
          error: {
            code: 'PAYMENT_NOT_CONFIGURED',
            message: 'Gateway pembayaran belum dikonfigurasi.',
            requestId,
            retryable: false,
          },
        });
    }
    // Amount is always derived server-side from catalog; client-supplied amountCents is ignored.
    const proCatalog = await options.catalog?.find('pro');
    const serverAmount = proCatalog?.priceAmount;
    if (!Number.isInteger(serverAmount) || (serverAmount ?? 0) <= 0) {
      return reply
        .status(503)
        .send({
          error: {
            code: 'PAYMENT_NOT_CONFIGURED',
            message: 'Harga Pro belum dikonfigurasi di katalog.',
            requestId,
            retryable: false,
          },
        });
    }
    try {
      await paymentService.createOrder({
        tenantId: workspaceId,
        workspaceId,
        idempotencyKey: `${workspaceId}:${orderId}`,
        externalOrderId: orderId,
        toPlan,
        amountCents: serverAmount!,
        currency: 'IDR',
      });
      const amount = serverAmount!;
      await new Promise<void>((resolve, reject) => {
        const pakasirRequest = httpsRequest(
          'https://app.pakasir.com/api/transactioncreate/qris',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          },
          (response) => {
            response.resume();
            response.on('end', () =>
              response.statusCode && response.statusCode < 300
                ? resolve()
                : reject(new Error(`Pakasir returned HTTP ${response.statusCode ?? 0}`)),
            );
          },
        );
        pakasirRequest.on('error', reject);
        pakasirRequest.end(
          JSON.stringify({ project: slug, order_id: orderId, amount, api_key: apiKey }),
        );
      });
      const paymentUrl = `https://app.pakasir.com/pay/${encodeURIComponent(slug)}/${amount}?order_id=${encodeURIComponent(orderId)}`;
      return reply.status(201).send({ paymentUrl });
    } catch (err) {
      handleError(err, request, reply);
    }
  });
}
