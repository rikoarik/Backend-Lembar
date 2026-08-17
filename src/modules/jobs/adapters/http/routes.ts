/**
 * Job status HTTP routes (B2-05).
 *
 * Provides GET /v1/jobs/:jobId with tenant isolation.
 * Uses neutral job statuses that are safe for client display.
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../../../infrastructure/database/db.js';
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

