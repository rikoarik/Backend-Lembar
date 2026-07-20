/**
 * B2-03 — HTTP routes for assessment configuration and draft.
 *
 * Endpoints:
 *   POST   /v1/workspaces/:workspaceId/assessments        — create config + draft
 *   GET    /v1/workspaces/:workspaceId/assessments        — list assessments
 *   GET    /v1/workspaces/:workspaceId/assessments/:id    — get assessment + version + blueprint
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { ApiError, buildErrorEnvelope } from '../../../../common/errors/envelope.js';
import type { AssessmentService } from '../../application/AssessmentService.js';
import type { QuestionType, Difficulty } from '../../domain/Assessment.js';

const VALID_QUESTION_TYPES: QuestionType[] = [
  'multiple_choice',
  'short_answer',
  'essay',
  'true_false',
];
const VALID_DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

interface CreateAssessmentBody {
  title: string;
  curriculumVersionId: string;
  gradeId: string;
  subjectId: string;
  sourceUploadIds: string[];
  blueprintItems: Array<{
    sequence: number;
    outcomeId?: string | null;
    questionType: string;
    difficulty: string;
    cognitiveLevel?: string | null;
    topicHint?: string | null;
    sourceUploadId?: string | null;
  }>;
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

export async function registerAssessmentRoutes(
  app: FastifyInstance,
  service: AssessmentService,
): Promise<void> {
  // POST /v1/workspaces/:workspaceId/assessments
  app.post(
    '/v1/workspaces/:workspaceId/assessments',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const body = request.body as CreateAssessmentBody;
      const requestId = getRequestId(request);
      const idempotencyKey = (request.headers['idempotency-key'] as string | undefined) ?? null;

      // Validate required fields
      if (!body || typeof body !== 'object') {
        return reply.status(400).send(
          buildErrorEnvelope({
            code: 'VALIDATION_FAILED',
            message: 'Request body is required',
            requestId,
          }),
        );
      }
      if (!body.title?.trim()) {
        return reply.status(400).send(
          buildErrorEnvelope({
            code: 'VALIDATION_FAILED',
            message: 'title is required',
            requestId,
            fieldErrors: { title: ['required'] },
          }),
        );
      }
      if (!body.curriculumVersionId?.trim()) {
        return reply.status(400).send(
          buildErrorEnvelope({
            code: 'VALIDATION_FAILED',
            message: 'curriculumVersionId is required',
            requestId,
            fieldErrors: { curriculumVersionId: ['required'] },
          }),
        );
      }
      if (!Array.isArray(body.blueprintItems) || body.blueprintItems.length === 0) {
        return reply.status(400).send(
          buildErrorEnvelope({
            code: 'VALIDATION_FAILED',
            message: 'blueprintItems must be a non-empty array',
            requestId,
            fieldErrors: { blueprintItems: ['min_items_1'] },
          }),
        );
      }

      // Validate blueprint item question types and difficulties
      for (const item of body.blueprintItems) {
        if (!VALID_QUESTION_TYPES.includes(item.questionType as QuestionType)) {
          return reply.status(400).send(
            buildErrorEnvelope({
              code: 'VALIDATION_FAILED',
              message: `Invalid questionType: ${item.questionType}`,
              requestId,
              fieldErrors: { blueprintItems: [`invalid_question_type:${item.questionType}`] },
            }),
          );
        }
        if (!VALID_DIFFICULTIES.includes(item.difficulty as Difficulty)) {
          return reply.status(400).send(
            buildErrorEnvelope({
              code: 'VALIDATION_FAILED',
              message: `Invalid difficulty: ${item.difficulty}`,
              requestId,
              fieldErrors: { blueprintItems: [`invalid_difficulty:${item.difficulty}`] },
            }),
          );
        }
      }

      try {
        // Extract actor user id from auth context (stub: use header for now, real auth in B1-01).
        const actorUserId =
          (request.headers['x-actor-user-id'] as string | undefined) ?? 'anonymous';

        const result = await service.createConfig({
          workspaceId,
          creatorUserId: actorUserId,
          title: body.title,
          curriculumVersionId: body.curriculumVersionId,
          gradeId: body.gradeId ?? '',
          subjectId: body.subjectId ?? '',
          sourceUploadIds: Array.isArray(body.sourceUploadIds) ? body.sourceUploadIds : [],
          blueprintItems: body.blueprintItems.map((item) => ({
            sequence: item.sequence,
            outcomeId: item.outcomeId ?? null,
            questionType: item.questionType as QuestionType,
            difficulty: item.difficulty as Difficulty,
            cognitiveLevel: item.cognitiveLevel ?? null,
            topicHint: item.topicHint ?? null,
            sourceUploadId: item.sourceUploadId ?? null,
          })),
          idempotencyKey,
          requestId,
        });

        const status = result.idempotent ? 200 : 201;
        return reply.status(status).send({
          assessment: result.assessment,
          version: result.version,
          blueprintItems: result.blueprintItems,
          idempotent: result.idempotent,
        });
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );

  // GET /v1/workspaces/:workspaceId/assessments
  app.get(
    '/v1/workspaces/:workspaceId/assessments',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const query = request.query as { limit?: string; cursor?: string };
      const limit = Math.min(parseInt(query.limit ?? '20', 10) || 20, 100);

      try {
        const assessments = await service.listAssessments(workspaceId, {
          limit,
          ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        });
        return reply.status(200).send({ assessments, count: assessments.length });
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );

  // GET /v1/workspaces/:workspaceId/assessments/:id
  app.get(
    '/v1/workspaces/:workspaceId/assessments/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, id } = request.params as { workspaceId: string; id: string };
      const requestId = getRequestId(request);

      try {
        const result = await service.getAssessment(workspaceId, id, requestId);
        return reply.status(200).send(result);
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );
}
