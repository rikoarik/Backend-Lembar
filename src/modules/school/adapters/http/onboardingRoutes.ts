/**
 * B7-03 — Teacher onboarding HTTP routes.
 *
 * POST /v1/school/onboarding/complete  — mark teacher as onboarded (idempotent)
 * GET  /v1/school/onboarding/status    — return current onboarding state
 *
 * Headers required:
 *   x-tenant-id  — tenant scope
 *   x-user-id    — user performing the action
 *   x-workspace-id — workspace scope
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import type { TeacherOnboardingService } from '../../application/TeacherOnboardingService.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'req_unknown';
}

export interface RegisterOnboardingRoutesOptions {
  onboardingService: TeacherOnboardingService;
}

export async function registerOnboardingRoutes(
  app: FastifyInstance,
  options: RegisterOnboardingRoutesOptions,
): Promise<void> {
  const { onboardingService } = options;

  /**
   * POST /v1/school/onboarding/complete
   * Marks the teacher's onboarding as completed. Idempotent.
   */
  app.post(
    '/v1/school/onboarding/complete',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request.headers['x-user-id'] as string | undefined) ?? '';
      const workspaceId = (request.headers['x-workspace-id'] as string | undefined) ?? '';
      const requestId = getRequestId(request);

      if (!userId || !workspaceId) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Missing x-user-id or x-workspace-id header',
            requestId,
            retryable: false,
          },
        });
      }

      const record = await onboardingService.completeOnboarding(userId, workspaceId);
      return reply.status(200).send({ data: record });
    },
  );

  /**
   * GET /v1/school/onboarding/status
   * Returns current onboarding state for the teacher.
   */
  app.get(
    '/v1/school/onboarding/status',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request.headers['x-user-id'] as string | undefined) ?? '';
      const workspaceId = (request.headers['x-workspace-id'] as string | undefined) ?? '';
      const requestId = getRequestId(request);

      if (!userId || !workspaceId) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Missing x-user-id or x-workspace-id header',
            requestId,
            retryable: false,
          },
        });
      }

      const record = await onboardingService.getStatus(userId, workspaceId);
      return reply.status(200).send({ data: record });
    },
  );
}
