/**
 * B7-04 — School billing HTTP routes.
 *
 * GET /v1/school/billing — seat count, plan tier, monthly usage
 *
 * Headers required:
 *   x-tenant-id    — tenant scope
 *   x-user-role    — must be school_admin (403 otherwise)
 * Query:
 *   workspaceId    — required
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import type { SchoolBillingService } from '../../application/SchoolBillingService.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'req_unknown';
}

export interface RegisterBillingRoutesOptions {
  billingService: SchoolBillingService;
}

export async function registerBillingRoutes(
  app: FastifyInstance,
  options: RegisterBillingRoutesOptions,
): Promise<void> {
  const { billingService } = options;

  /**
   * GET /v1/school/billing
   * school_admin only — returns BillingSnapshot
   */
  app.get('/v1/school/billing', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = (request.headers['x-tenant-id'] as string | undefined) ?? '';
    const userRole = (request.headers['x-user-role'] as string | undefined) ?? '';
    const { workspaceId } = request.query as { workspaceId?: string };
    const requestId = getRequestId(request);

    if (!tenantId) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Missing x-tenant-id header',
          requestId,
          retryable: false,
        },
      });
    }

    // Billing endpoint: school_admin only
    if (userRole !== 'school_admin') {
      return reply.status(403).send({
        error: {
          code: 'PERMISSION_DENIED',
          message: 'Billing endpoint requires school_admin role',
          requestId,
          retryable: false,
        },
      });
    }

    if (!workspaceId) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Missing workspaceId query parameter',
          requestId,
          retryable: false,
        },
      });
    }

    const snapshot = await billingService.getBillingSnapshot(tenantId, workspaceId);
    return reply.status(200).send({ data: snapshot });
  });
}
