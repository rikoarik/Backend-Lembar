import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ApiError } from '../../../../common/errors/envelope.js';
import { authenticate } from '../../../../common/middleware/authenticate.js';
import { rateLimit } from '../../../../common/security/rateLimit.js';
import type { PlanService } from '../../application/PlanService.js';
import { TrialEligibilityError, type TrialService } from '../../application/TrialService.js';
import { TrialConflictError } from '../../persistence/trialRepository.js';
import type { PlanCatalogRepository } from '../../persistence/catalogRepository.js';

export interface PlanRouteOptions {
  trials: TrialService;
  jwtSecret: string;
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

function authContext(req: FastifyRequest, reply: FastifyReply, secret: string) {
  const auth = authenticate(req, { secret });
  if (!auth.workspaceId) {
    sendError(reply, req, 409, 'TRIAL_WORKSPACE_REQUIRED', 'Workspace aktif diperlukan.');
    return null;
  }
  return auth;
}

function handleError(err: unknown, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ApiError) return reply.status(err.status).send(err.toEnvelope());
  if (err instanceof TrialConflictError || err instanceof TrialEligibilityError) {
    if (err.code === 'TRIAL_DEVICE_REQUIRED' || err.code === 'TRIAL_PROFILE_INCOMPLETE') {
      return sendError(reply, req, 400, err.code, 'Email dan nomor telepon wajib dilengkapi.');
    }
    return sendError(
      reply,
      req,
      409,
      err.code,
      'Trial tidak tersedia untuk akun atau perangkat ini.',
    );
  }
  return sendError(reply, req, 500, 'INTERNAL_ERROR', 'Terjadi kesalahan internal.');
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
      const auth = authContext(request, reply, options.jwtSecret);
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
      const auth = authContext(request, reply, options.jwtSecret);
      if (!auth) return;
      if (
        auth.roles.includes('superadmin') ||
        auth.roles.includes('school_admin') ||
        !auth.roles.some((role) => role === 'teacher' || role === 'subscriber')
      ) {
        return sendError(
          reply,
          request,
          403,
          'TRIAL_NOT_ELIGIBLE',
          'Role ini tidak memenuhi syarat trial.',
        );
      }
      const deviceToken = (request.body as { deviceToken?: unknown } | null)?.deviceToken;
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
        deviceToken,
        ip: request.ip,
      });
      const summary = await service.getPlanSummary(auth.tenantId, auth.workspaceId!, deviceToken);
      return reply.status(201).send({ data: summary });
    } catch (error) {
      return handleError(error, request, reply);
    }
  });
}
