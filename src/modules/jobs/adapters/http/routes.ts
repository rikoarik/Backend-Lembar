/**
 * Job status HTTP routes (B2-05).
 *
 * Provides GET /v1/jobs/:jobId with tenant isolation.
 * Uses neutral job statuses that are safe for client display.
 */
import type { FastifyInstance } from 'fastify';
import type { JobStatusService } from '../../application/JobStatusService.js';
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

export function registerJobStatusRoutes(
  app: FastifyInstance,
  jobStatusService: JobStatusService,
): void {
  app.get<{ Params: JobParams; Querystring: JobQuery }>(
    '/v1/jobs/:jobId',
    async (request, reply) => {
      const { jobId } = request.params;
      const workspaceId = request.query.workspaceId ?? (request.headers['x-workspace-id'] as string);

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

  app.post<{ Params: JobParams; Querystring: JobQuery }>(
    '/v1/jobs/:jobId/cancel',
    async (request, reply) => {
      const { jobId } = request.params;
      const workspaceId = request.query.workspaceId ?? (request.headers['x-workspace-id'] as string);

      if (!workspaceId) {
        return reply.status(400).send({
          error: { code: 'MISSING_WORKSPACE', message: 'workspaceId is required' },
        });
      }

      const tenantCtx = { tenantId: workspaceId, workspaceId };

      try {
        const status = await jobStatusService.cancel(jobId, tenantCtx, workspaceId);
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
    async (request, reply) => {
      const { jobId } = request.params;
      const workspaceId = request.query.workspaceId ?? (request.headers['x-workspace-id'] as string);

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
          workspaceId,
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
