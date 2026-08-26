/**
 * Job status HTTP routes (B2-05).
 *
 * Provides GET /v1/jobs/:jobId with tenant isolation.
 * Uses neutral job statuses that are safe for client display.
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../../../infrastructure/database/db.js';
import { getPool } from '../../../../infrastructure/database/db.js';
import type { JobStatusService } from '../../application/JobStatusService.js';
import { createJwtAuthMiddleware } from '../../../../common/middleware/jwtMultiRoleAuth.js';
import {
  JobNotFoundError,
  JobTenantMismatchError,
  JobNotCancellableError,
} from '../../domain/errors.js';

interface JobParams {
  jobId: string;
}

interface JobQuery {
  workspaceId?: string;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function registerJobStatusRoutes(
  app: FastifyInstance,
  jobStatusService: JobStatusService,
  options: { jwtSecret: string; db?: Database | undefined },
): void {
  const auth = createJwtAuthMiddleware({ secret: options.jwtSecret, ...(options.db ? { db: options.db } : {}) });
  app.get<{ Params: JobParams; Querystring: JobQuery }>(
    '/v1/jobs/:jobId',
    { preHandler: auth },
    async (request, reply) => {
      const { jobId } = request.params;
      const workspaceId = request.jwtUser!.workspaceId;

      if (!workspaceId) {
        return reply.status(400).send({
          error: { code: 'MISSING_WORKSPACE', message: 'workspaceId is required' },
        });
      }

      const tenantCtx = { tenantId: workspaceId, workspaceId };

      try {
        const status = await jobStatusService.getStatus(jobId, tenantCtx);
        return reply.status(200).send({ data: status });
      } catch (err: unknown) {
        if (err instanceof JobNotFoundError) {
          return reply.status(404).send({
            error: { code: 'JOB_NOT_FOUND', message: err.message },
          });
        }
        if (err instanceof JobTenantMismatchError) {
          return reply.status(404).send({
            error: { code: 'JOB_NOT_FOUND', message: 'Job not found' },
          });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: JobParams }>(
    '/v1/jobs/:jobId/events',
    { preHandler: auth },
    async (request, reply) => {
      const { jobId } = request.params;
      const workspaceId = request.jwtUser!.workspaceId;
      if (!workspaceId || !options.db || !isUuid(jobId)) {
        return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'Job tidak valid.' } });
      }
      const tenantCtx = { tenantId: workspaceId, workspaceId };
      try {
        await jobStatusService.getStatus(jobId, tenantCtx);
      } catch (err) {
        if (err instanceof JobNotFoundError || err instanceof JobTenantMismatchError) {
          return reply.status(404).send({ error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } });
        }
        throw err;
      }

      const channel = `lembar_job_${jobId.replaceAll('-', '')}`;
      const pool = getPool(options.db);
      if (!pool) return reply.status(503).send({ error: { code: 'DB_UNAVAILABLE', message: 'Database tidak tersedia.' } });
      const client = await pool.connect();
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const emit = async () => {
        const status = await jobStatusService.getStatus(jobId, tenantCtx);
        reply.raw.write(`event: status\ndata: ${JSON.stringify({ data: status })}\n\n`);
      };
      client.on('notification', () => void emit().catch(() => reply.raw.end()));
      await client.query(`LISTEN ${channel}`);
      await emit();
      const heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 25_000);
      request.raw.on('close', () => {
        clearInterval(heartbeat);
        void client.query(`UNLISTEN ${channel}`).catch(() => undefined).finally(() => client.release());
      });
    },
  );

  app.post<{ Params: JobParams; Querystring: JobQuery }>(
    '/v1/jobs/:jobId/cancel',
    { preHandler: auth },
    async (request, reply) => {
      const { jobId } = request.params;
      const workspaceId = request.jwtUser!.workspaceId;

      if (!workspaceId) {
        return reply.status(400).send({
          error: { code: 'MISSING_WORKSPACE', message: 'workspaceId is required' },
        });
      }

      const tenantCtx = { tenantId: workspaceId, workspaceId };

      try {
        const status = await jobStatusService.cancel(jobId, tenantCtx, request.jwtUser!.userId);
        return reply.status(200).send({ data: status });
      } catch (err: unknown) {
        if (err instanceof JobNotFoundError) {
          return reply.status(404).send({
            error: { code: 'JOB_NOT_FOUND', message: err.message },
          });
        }
        if (err instanceof JobTenantMismatchError) {
          return reply.status(404).send({
            error: { code: 'JOB_NOT_FOUND', message: 'Job not found' },
          });
        }
        if (err instanceof JobNotCancellableError) {
          return reply.status(409).send({
            error: { code: 'JOB_NOT_CANCELLABLE', message: err.message },
          });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: JobParams; Querystring: JobQuery }>(
    '/v1/jobs/:jobId/recover',
    { preHandler: auth },
    async (request, reply) => {
      const { jobId } = request.params;
      const workspaceId = request.jwtUser!.workspaceId;

      if (!workspaceId) {
        return reply.status(400).send({
          error: { code: 'MISSING_WORKSPACE', message: 'workspaceId is required' },
        });
      }

      const tenantCtx = { tenantId: workspaceId, workspaceId };

      try {
        const status = await jobStatusService.recover(
          jobId,
          tenantCtx,
          request.jwtUser!.userId,
          'manual recovery via API',
        );
        return reply.status(200).send({ data: status });
      } catch (err: unknown) {
        if (err instanceof JobNotFoundError) {
          return reply.status(404).send({
            error: { code: 'JOB_NOT_FOUND', message: err.message },
          });
        }
        if (err instanceof JobTenantMismatchError) {
          return reply.status(404).send({
            error: { code: 'JOB_NOT_FOUND', message: 'Job not found' },
          });
        }
        throw err;
      }
    },
  );
}
