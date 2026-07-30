/**
 * LMS-A — Guest attempt HTTP routes. No auth required (guest access).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { buildErrorEnvelope } from '../../../../common/errors/envelope.js';
import { AttemptService } from '../../application/AttemptService.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'unknown';
}

export async function registerAttemptRoutes(
  app: FastifyInstance,
  service: AttemptService,
): Promise<void> {
  // POST /v1/assessments/:assessmentId/attempts — start a guest attempt
  app.post(
    '/v1/assessments/:assessmentId/attempts',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { assessmentId } = request.params as { assessmentId: string };
      const body = request.body as { guestName?: string; guestClass?: string } | null;
      const requestId = getRequestId(request);

      if (!body?.guestName?.trim()) {
        return reply.status(400).send(
          buildErrorEnvelope({
            code: 'VALIDATION_FAILED',
            message: 'guestName is required',
            requestId,
            fieldErrors: { guestName: ['required'] },
          }),
        );
      }

      const attempt = await service.startGuestAttempt(
        assessmentId,
        body.guestName.trim(),
        body.guestClass?.trim() || undefined,
      );
      return reply.status(201).send({ data: attempt });
    },
  );

  // PUT /v1/attempts/:id/submit — submit answers for a guest attempt
  app.put(
    '/v1/attempts/:id/submit',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { answers?: Record<string, string> } | null;
      const requestId = getRequestId(request);

      if (!body?.answers || typeof body.answers !== 'object') {
        return reply.status(400).send(
          buildErrorEnvelope({
            code: 'VALIDATION_FAILED',
            message: 'answers is required',
            requestId,
            fieldErrors: { answers: ['required'] },
          }),
        );
      }

      try {
        const submitted = await service.submitAttempt(id, body.answers);
        return reply.status(200).send({ data: submitted });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Not found';
        return reply.status(404).send(
          buildErrorEnvelope({ code: 'RESOURCE_NOT_FOUND', message, requestId }),
        );
      }
    },
  );
}
