/**
 * Subscription/plan change HTTP routes (B6-02).
 *
 * POST /v1/me/plan/upgrade   — upgrade workspace ke pro
 * POST /v1/me/plan/downgrade — downgrade workspace ke free
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import type { PaymentService } from '../../application/PaymentService.js';
import { InvalidPlanTransitionError, OrderNotFoundError } from '../../domain/errors.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'req_unknown';
}

function handleError(err: unknown, req: FastifyRequest, reply: FastifyReply): void {
  const requestId = getRequestId(req);
  if (err instanceof InvalidPlanTransitionError) {
    void reply.status(409).send({
      error: { code: 'INVALID_PLAN_TRANSITION', message: err.message, requestId, retryable: false },
    });
    return;
  }
  if (err instanceof OrderNotFoundError) {
    void reply.status(404).send({
      error: { code: 'ORDER_NOT_FOUND', message: err.message, requestId, retryable: false },
    });
    return;
  }
  void reply.status(500).send({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId, retryable: false },
  });
}

export interface RegisterSubscriptionRoutesOptions {
  paymentService: PaymentService;
}

export async function registerSubscriptionRoutes(
  app: FastifyInstance,
  options: RegisterSubscriptionRoutesOptions,
): Promise<void> {
  const { paymentService } = options;

  /**
   * POST /v1/me/plan/upgrade
   *
   * Upgrade workspace plan to pro. Requires a paid orderId or admin bypass.
   *
   * Headers: x-tenant-id, x-workspace-id, x-actor-id
   * Body: { orderId?: string }
   */
  app.post('/v1/me/plan/upgrade', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = getRequestId(request);
    const tenantId = request.headers['x-tenant-id'] as string | undefined;
    const workspaceId = request.headers['x-workspace-id'] as string | undefined;
    const actorId = (request.headers['x-actor-id'] as string | undefined) ?? 'unknown';

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

    const body = (request.body as Record<string, unknown>) ?? {};
    const orderId = body['orderId'] as string | undefined;

    try {
      const result = await paymentService.upgradePlan({
        tenantId,
        workspaceId,
        actorId,
        targetPlan: 'pro',
        orderId,
      });
      return reply.status(200).send({ data: result });
    } catch (err) {
      handleError(err, request, reply);
    }
  });

  /**
   * POST /v1/me/plan/downgrade
   *
   * Downgrade workspace plan back to free.
   *
   * Headers: x-tenant-id, x-workspace-id, x-actor-id
   */
  app.post('/v1/me/plan/downgrade', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = getRequestId(request);
    const tenantId = request.headers['x-tenant-id'] as string | undefined;
    const workspaceId = request.headers['x-workspace-id'] as string | undefined;
    const actorId = (request.headers['x-actor-id'] as string | undefined) ?? 'unknown';

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
      const result = await paymentService.downgradePlan({
        tenantId,
        workspaceId,
        actorId,
        targetPlan: 'free',
      });
      return reply.status(200).send({ data: result });
    } catch (err) {
      handleError(err, request, reply);
    }
  });
}
