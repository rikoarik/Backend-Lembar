/**
 * B6-03 — Superadmin HTTP routes.
 *
 * All routes require Bearer SUPERADMIN_TOKEN in Authorization header.
 * 403 if token missing or wrong. All actions audit-logged.
 *
 * Routes:
 *   GET  /v1/admin/accounts
 *   GET  /v1/admin/jobs
 *   GET  /v1/admin/quality-reports
 *   POST /v1/admin/entitlements/:workspaceId
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import type { AdminService } from '../../application/AdminService.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'req_unknown';
}

function errReply(reply: FastifyReply, status: number, code: string, message: string, reqId: string): void {
  void reply.status(status).send({
    error: { code, message, requestId: reqId, retryable: false },
  });
}

/**
 * Validates Bearer SUPERADMIN_TOKEN from the Authorization header.
 * Returns actor id 'superadmin' or sends 403 and returns null.
 */
function requireSuperadmin(
  req: FastifyRequest,
  reply: FastifyReply,
  superadminToken: string,
): string | null {
  const auth = (req.headers['authorization'] as string | undefined) ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';

  if (!token || token !== superadminToken) {
    errReply(reply, 403, 'PERMISSION_DENIED', 'Superadmin token required.', getRequestId(req));
    return null;
  }
  return 'superadmin';
}

export interface RegisterAdminRoutesOptions {
  service: AdminService;
  superadminToken: string;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  options: RegisterAdminRoutesOptions,
): Promise<void> {
  const { service, superadminToken } = options;

  /**
   * GET /v1/admin/accounts
   */
  app.get('/v1/admin/accounts', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = requireSuperadmin(request, reply, superadminToken);
    if (!actor) return;

    const accounts = await service.listAccounts(actor);
    return reply.status(200).send({ data: accounts });
  });

  /**
   * GET /v1/admin/jobs
   */
  app.get('/v1/admin/jobs', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = requireSuperadmin(request, reply, superadminToken);
    if (!actor) return;

    const q = request.query as Record<string, string>;
    const limit = q['limit'] ? parseInt(q['limit'], 10) : undefined;

    const jobs = await service.listJobs(actor, limit);
    return reply.status(200).send({ data: jobs });
  });

  /**
   * GET /v1/admin/quality-reports
   */
  app.get('/v1/admin/quality-reports', async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = requireSuperadmin(request, reply, superadminToken);
    if (!actor) return;

    const q = request.query as Record<string, string>;
    const limit = q['limit'] ? parseInt(q['limit'], 10) : undefined;

    const reports = await service.listQualityReports(actor, limit);
    return reply.status(200).send({ data: reports });
  });

  /**
   * POST /v1/admin/entitlements/:workspaceId
   * Body: { plan: 'free' | 'pro', tenantId: string }
   */
  app.post(
    '/v1/admin/entitlements/:workspaceId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireSuperadmin(request, reply, superadminToken);
      if (!actor) return;

      const { workspaceId } = request.params as { workspaceId: string };
      const body = request.body as Record<string, unknown> | null | undefined;

      const plan = body?.['plan'];
      if (!plan || !['free', 'pro'].includes(plan as string)) {
        errReply(reply, 400, 'VALIDATION_FAILED', "Field 'plan' must be 'free' or 'pro'.", getRequestId(request));
        return;
      }

      const result = await service.setEntitlement(actor, {
        workspaceId,
        plan: plan as 'free' | 'pro',
        actorId: actor,
      });
      return reply.status(200).send({ data: result });
    },
  );
}
