/**
 * LMS-B — HTTP routes for member attempts.
 *
 * POST /v1/workspaces/:workspaceId/assessments/:assessmentId/member-attempts
 *   Auth required: expects x-actor-user-id header (same pattern as assessments module).
 *
 * PUT /v1/member-attempts/:id/submit
 *   Submit answers for an in-progress attempt.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { ApiError, buildErrorEnvelope } from '../../../../common/errors/envelope.js';
import type { AttemptService } from '../../application/AttemptService.js';

function getRequestId(request: FastifyRequest): string {
  return (request.headers['x-request-id'] as string | undefined) ?? 'unknown';
}

function handleError(err: unknown, request: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof ApiError) {
    reply.status(err.status).send(err.toEnvelope());
    return;
  }
  reply.status(500).send(
    buildErrorEnvelope({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: getRequestId(request),
    }),
  );
}

export async function registerMemberAttemptRoutes(
  app: FastifyInstance,
  service: AttemptService,
): Promise<void> {
  // POST /v1/workspaces/:workspaceId/assessments/:assessmentId/member-attempts
  app.post(
    '/v1/workspaces/:workspaceId/assessments/:assessmentId/member-attempts',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, assessmentId } = request.params as {
        workspaceId: string;
        assessmentId: string;
      };
      const requestId = getRequestId(request);

      // Auth: require actor (same header convention as uploads/assessments modules)
      const memberId = request.headers['x-actor-user-id'] as string | undefined;
      if (!memberId) {
        return reply.status(401).send(
          buildErrorEnvelope({
            code: 'AUTH_REQUIRED',
            message: 'Autentikasi diperlukan.',
            requestId,
          }),
        );
      }

      try {
        const attempt = await service.startMemberAttempt(workspaceId, assessmentId, memberId);
        return reply.status(201).send({ attempt });
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );

  // PUT /v1/member-attempts/:id/submit
  app.put(
    '/v1/member-attempts/:id/submit',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { answers?: Record<string, string> };

      if (!body || typeof body.answers !== 'object' || body.answers === null) {
        return reply.status(400).send(
          buildErrorEnvelope({
            code: 'VALIDATION_FAILED',
            message: 'answers object is required',
            requestId: getRequestId(request),
          }),
        );
      }

      try {
        const attempt = await service.submitMemberAttempt(id, body.answers);
        return reply.status(200).send({ attempt });
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );
}
