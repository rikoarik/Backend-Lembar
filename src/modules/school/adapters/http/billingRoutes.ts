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
import { createJwtAuthMiddleware, requireRole } from '../../../../common/middleware/jwtMultiRoleAuth.js';
import type { Database } from '../../../../infrastructure/database/db.js';
import { throwApiError } from '../../../../common/errors/apiError.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'req_unknown';
}

export interface RegisterBillingRoutesOptions {
  billingService: SchoolBillingService;
  jwtSecret: string;
  db?: Database;
}

export async function registerBillingRoutes(
  app: FastifyInstance,
  options: RegisterBillingRoutesOptions,
): Promise<void> {
  const { billingService, jwtSecret, db } = options;
  const auth = createJwtAuthMiddleware({ secret: jwtSecret, db });

  /**
   * GET /v1/school/billing
   * school_admin only — returns BillingSnapshot
   */
  app.get('/v1/school/billing', { preHandler: [auth, requireRole(['school_admin'])] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = request.jwtUser?.workspaceId;
    if (!workspaceId) throwApiError('forbidden', 'Akun tidak terhubung ke workspace sekolah');
    const snapshot = await billingService.getBillingSnapshot(workspaceId, workspaceId);
    return reply.status(200).send({ data: snapshot });
  });
}
