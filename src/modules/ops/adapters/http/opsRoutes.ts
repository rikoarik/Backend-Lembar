/**
 * B6-04 — Ops routes: GET /v1/metrics and POST /v1/leads.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import type { MetricsCollector } from '../../application/MetricsCollector.js';
import {
  LeadCaptureService,
  LeadValidationError,
  LeadTooFrequentError,
} from '../../application/LeadCaptureService.js';

function getRequestId(req: FastifyRequest): string {
  return (req.headers['x-request-id'] as string | undefined) ?? 'req_unknown';
}

export interface RegisterOpsRoutesOptions {
  metrics: MetricsCollector;
  leads: LeadCaptureService;
}

export async function registerOpsRoutes(
  app: FastifyInstance,
  options: RegisterOpsRoutesOptions,
): Promise<void> {
  const { metrics, leads } = options;

  /**
   * GET /v1/metrics
   * Returns request count, p95 latency, and current queue depth.
   */
  app.get('/v1/metrics', async (_request: FastifyRequest, reply: FastifyReply) => {
    const snapshot = metrics.getSnapshot();
    return reply.status(200).send({
      data: {
        requestCount: snapshot.requestCount,
        latencyP95Ms: snapshot.latencyP95Ms,
        queueDepth: snapshot.queueDepth,
        capturedAt: new Date().toISOString(),
      },
    });
  });

  /**
   * POST /v1/leads
   * Body: { name, email, school, role }
   * Rate limit: 3 submissions per email per hour → 429.
   */
  app.post('/v1/leads', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown> | null | undefined;

    const input = {
      name: (body?.['name'] as string | undefined) ?? '',
      email: (body?.['email'] as string | undefined) ?? '',
      school: (body?.['school'] as string | undefined) ?? '',
      role: (body?.['role'] as string | undefined) ?? '',
    };

    try {
      const lead = await leads.capture(input);
      return reply.status(201).send({ data: lead });
    } catch (err) {
      if (err instanceof LeadValidationError) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: err.message,
            requestId: getRequestId(request),
            retryable: false,
            fieldErrors: err.fields,
          },
        });
      }
      if (err instanceof LeadTooFrequentError) {
        return reply.status(429).send({
          error: {
            code: 'RATE_LIMITED',
            message: err.message,
            requestId: getRequestId(request),
            retryable: true,
          },
        });
      }
      throw err;
    }
  });
}
