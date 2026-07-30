/**
 * LMS-A — Guest attempt HTTP routes. No auth required (guest access).
 * LMS-G — Per-IP rate limit: max 5 starts per assessment per 10 min.
 *         Duplicate submit blocked: returns 409 STATE_CONFLICT.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ApiError, buildErrorEnvelope } from '../../../../common/errors/envelope.js';
import { AttemptService } from '../../application/AttemptService.js';

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Sliding-window per-IP+assessment rate limit store.
 * Exported so tests can reset state between runs.
 * key: `${ip}:${assessmentId}` → sorted array of timestamps
 * ponytail: in-memory only; replace with Redis when horizontally scaling.
 */
export const attemptRateLimitStore = new Map<string, number[]>();

function checkRateLimit(ip: string, assessmentId: string): boolean {
  const key = `${ip}:${assessmentId}`;
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (attemptRateLimitStore.get(key) ?? []).filter((t) => t > cutoff);
  if (timestamps.length >= RATE_LIMIT_MAX) return false;
  timestamps.push(now);
  attemptRateLimitStore.set(key, timestamps);
  return true;
}

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

      if (!checkRateLimit(request.ip, assessmentId)) {
        return reply.status(429).send(
          buildErrorEnvelope({
            code: 'RATE_LIMITED',
            message: 'Too many attempts. Please try again later.',
            requestId,
            retryable: true,
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

  // GET /v1/assessments/:assessmentId/scores — leaderboard of submitted+graded attempts
  app.get(
    '/v1/assessments/:assessmentId/scores',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { assessmentId } = request.params as { assessmentId: string };
      const data = await service.getScoreDashboard(assessmentId);
      return reply.status(200).send({ data });
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
        if (err instanceof ApiError) {
          return reply.status(err.status).send(err.toEnvelope());
        }
        const message = err instanceof Error ? err.message : 'Not found';
        return reply.status(404).send(
          buildErrorEnvelope({ code: 'RESOURCE_NOT_FOUND', message, requestId }),
        );
      }
    },
  );
}
