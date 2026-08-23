import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ApiError } from '../../../../common/errors/envelope.js';
import { authenticateWithDb } from '../../../../common/middleware/authenticateWithDb.js';
import { rateLimit } from '../../../../common/security/rateLimit.js';
import type { PlanService } from '../../application/PlanService.js';
import { TrialEligibilityError, type TrialService } from '../../application/TrialService.js';
import { TrialConflictError } from '../../persistence/trialRepository.js';
import type { PlanCatalogRepository } from '../../persistence/catalogRepository.js';

export interface PlanRouteOptions {
  trials: TrialService;
  jwtSecret: string;
  db?: import('../../../../infrastructure/database/db.js').Database | undefined;
  catalog?: Pick<PlanCatalogRepository, 'list'>;
}

function requestId(req: FastifyRequest) {
  return (req.headers['x-request-id'] as string | undefined) ?? 'req_unknown';
}

function sendError(
  reply: FastifyReply,
  req: FastifyRequest,
  status: number,
  code: string,
  message: string,
) {
  return reply
    .status(status)
    .send({ error: { code, message, requestId: requestId(req), retryable: false } });
}

async function authContext(
  req: FastifyRequest,
  reply: FastifyReply,
  secret: string,
  db?: Parameters<typeof authenticateWithDb>[1]['db'],
) {
  const auth = await authenticateWithDb(req, { secret, ...(db ? { db } : {}) });
  if (!auth.workspaceId) {
    sendError(reply, req, 409, 'TRIAL_WORKSPACE_REQUIRED', 'Workspace aktif diperlukan.');
    return null;
  }
  return auth;
}

function handleError(err: unknown, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ApiError) return reply.status(err.status).send(err.toEnvelope());
  if (err instanceof TrialConflictError || err instanceof TrialEligibilityError) {
    if (err.code === 'TRIAL_PROFILE_INCOMPLETE') {
      return sendError(reply, req, 400, err.code, 'Email dan nomor telepon wajib dilengkapi.');
    }
    if (err.code === 'TRIAL_DEVICE_REQUIRED') {
      return sendError(reply, req, 400, err.code, 'Identitas perangkat tidak valid.');
    }
    if (err.code === 'TRIAL_CLAIM_LINK_REQUIRED') {
      return sendError(reply, req, 400, err.code, 'Tautan klaim trial wajib digunakan.');
    }
    return sendError(
      reply,
      req,
      409,
      err.code,
      'Trial atau tautan klaim tidak tersedia untuk akun ini.',
    );
  }
  return sendError(reply, req, 500, 'INTERNAL_ERROR', 'Terjadi kesalahan internal.');
}

function hasEligibleTrialRole(roles: string[]): boolean {
  return (
    !roles.includes('superadmin') &&
    !roles.includes('school_admin') &&
    roles.some((role) => role === 'teacher' || role === 'subscriber')
  );
}

function rejectIneligibleRole(reply: FastifyReply, request: FastifyRequest) {
  return sendError(
    reply,
    request,
    403,
    'TRIAL_NOT_ELIGIBLE',
    'Role ini tidak memenuhi syarat trial.',
  );
}

export async function registerPlanRoutes(
  app: FastifyInstance,
  service: PlanService,
  options?: PlanRouteOptions,
) {
  app.get('/v1/public/plans', async (_request, reply) => {
    const plans = (await options?.catalog?.list(true)) ?? [];
    return reply.header('cache-control', 'public, max-age=60, stale-while-revalidate=300').send({
      data: plans.map(
        ({
          key,
          displayName,
          priceAmount,
          currency,
          billingPeriod,
          tokenMonthlyLimit,
          features,
        }) => ({
          key,
          displayName,
          priceAmount,
          currency,
          billingPeriod,
          tokenMonthlyLimit,
          features,
        }),
      ),
    });
  });

  app.get('/v1/me/plan', async (request, reply) => {
    if (!options) return sendError(reply, request, 500, 'INTERNAL_ERROR', 'Plan auth unavailable');
    try {
      const auth = await authContext(request, reply, options.jwtSecret, options.db);
      if (!auth) return;
      const deviceToken = request.headers['x-trial-device-token'];
      return reply.status(200).send({
        data: await service.getPlanSummary(
          auth.tenantId,
          auth.workspaceId!,
          typeof deviceToken === 'string' ? deviceToken : undefined,
        ),
      });
    } catch (error) {
      return handleError(error, request, reply);
    }
  });


  app.post('/v1/me/plan/trial/claim', async (request, reply) => {
    if (!options) return sendError(reply, request, 500, 'INTERNAL_ERROR', 'Trial unavailable');
    try {
      rateLimit(request, reply, 'trial-claim', 5, 24 * 60 * 60 * 1000);
      const auth = await authContext(request, reply, options.jwtSecret, options.db);
      if (!auth) return;
      if (!hasEligibleTrialRole(auth.roles)) return rejectIneligibleRole(reply, request);
      const body = request.body as { claimToken?: unknown; deviceToken?: unknown } | null;
      const claimToken = body?.claimToken;
      if (typeof claimToken !== 'string' || claimToken.length < 32 || claimToken.length > 512) {
        return sendError(
          reply,
          request,
          400,
          'TRIAL_CLAIM_LINK_REQUIRED',
          'Tautan klaim trial tidak valid.',
        );
      }
      const deviceToken = body?.deviceToken;
      if (typeof deviceToken !== 'string' || deviceToken.length < 16 || deviceToken.length > 512) {
        return sendError(
          reply,
          request,
          400,
          'TRIAL_DEVICE_REQUIRED',
          'Identitas perangkat tidak valid.',
        );
      }
      await options.trials.claim({
        userId: auth.userId,
        workspaceId: auth.workspaceId!,
        claimToken,
        deviceToken,
        ip: request.ip,
      });
      const summary = await service.getPlanSummary(auth.tenantId, auth.workspaceId!, deviceToken);
      return reply.header('cache-control', 'no-store').status(201).send({ data: summary });
    } catch (error) {
      return handleError(error, request, reply);
    }
  });
}
