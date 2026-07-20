/**
 * B3-02 — HTTP routes for blueprint pipeline.
 *
 * Endpoints:
 *   POST /v1/workspaces/:workspaceId/assessments/:assessmentId/versions/:versionId/blueprint
 *   GET  /v1/workspaces/:workspaceId/assessments/:assessmentId/versions/:versionId/blueprint
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { ApiError, buildErrorEnvelope } from '../../../../common/errors/envelope.js';
import type { BlueprintPipelineService } from '../../application/BlueprintPipelineService.js';
import type { CoverageTargets } from '../../domain/BlueprintPipeline.js';

interface BuildBlueprintBody {
  blueprintSchemaVersion?: string;
  coverageTargets?: {
    minTotalItems?: number;
    maxTotalItems?: number;
    difficultyDistribution?: Record<string, number>;
    questionTypeDistribution?: Record<string, number>;
    minSourceCoverage?: number;
  };
}

function getRequestId(request: FastifyRequest): string {
  return (request.headers['x-request-id'] as string | undefined) ?? 'unknown';
}

function handleError(err: unknown, request: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof ApiError) {
    reply.status(err.status).send(err.toEnvelope());
    return;
  }
  const requestId = getRequestId(request);
  reply.status(500).send(
    buildErrorEnvelope({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId,
    }),
  );
}

export async function registerBlueprintPipelineRoutes(
  app: FastifyInstance,
  service: BlueprintPipelineService,
): Promise<void> {
  // POST /v1/workspaces/:workspaceId/assessments/:assessmentId/versions/:versionId/blueprint
  app.post(
    '/v1/workspaces/:workspaceId/assessments/:assessmentId/versions/:versionId/blueprint',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, versionId } = request.params as {
        workspaceId: string;
        assessmentId: string;
        versionId: string;
      };
      const body = (request.body ?? {}) as BuildBlueprintBody;
      const requestId = getRequestId(request);

      // Defaults
      const blueprintSchemaVersion = body.blueprintSchemaVersion ?? '1.0.0';
      const coverageTargets: CoverageTargets = {
        minTotalItems: body.coverageTargets?.minTotalItems ?? 1,
        maxTotalItems: body.coverageTargets?.maxTotalItems ?? 100,
        difficultyDistribution: body.coverageTargets?.difficultyDistribution ?? {
          easy: 0.2,
          medium: 0.5,
          hard: 0.3,
        },
        questionTypeDistribution: body.coverageTargets?.questionTypeDistribution ?? {
          multiple_choice: 0.4,
          short_answer: 0.3,
          essay: 0.2,
          true_false: 0.1,
        },
        minSourceCoverage: body.coverageTargets?.minSourceCoverage ?? 0.5,
      };

      try {
        const result = await service.buildBlueprint({
          workspaceId,
          assessmentVersionId: versionId,
          blueprintSchemaVersion,
          coverageTargets,
          requestId,
        });

        const status = result.cached ? 200 : 201;
        return reply.status(status).send({
          snapshot: result.snapshot,
          validation: result.validation,
          cached: result.cached,
        });
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );

  // GET /v1/workspaces/:workspaceId/assessments/:assessmentId/versions/:versionId/blueprint
  app.get(
    '/v1/workspaces/:workspaceId/assessments/:assessmentId/versions/:versionId/blueprint',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, versionId } = request.params as {
        workspaceId: string;
        assessmentId: string;
        versionId: string;
      };
      const requestId = getRequestId(request);

      try {
        const snapshot = await service.getBlueprint(workspaceId, versionId);
        if (!snapshot) {
          return reply.status(404).send(
            buildErrorEnvelope({
              code: 'RESOURCE_NOT_FOUND',
              message: 'Blueprint snapshot not found',
              requestId,
            }),
          );
        }
        return reply.status(200).send({ snapshot });
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );
}
