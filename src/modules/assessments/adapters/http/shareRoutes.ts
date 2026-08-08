/**
 * B5-03 — HTTP routes for controlled share links.
 *
 * Endpoints:
 *   GET    /v1/shares                    — list share links by assessmentId (tenant-scoped)
 *   POST   /v1/shares                    — create share link (tenant-scoped)
 *   GET    /v1/shares/:token             — public access, validate token + expiry + title + questions (B4 fix)
 *   DELETE /v1/shares/:token/revoke      — revoke share link (owner only)
 *
 * Tenant isolation: workspaceId from x-workspace-id header.
 * Public endpoint (GET /:token) does not require workspace header.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { ApiError, buildErrorEnvelope } from '../../../../common/errors/envelope.js';
import type { ShareLinkService } from '../../application/ShareLinkService.js';
import type { AssessmentsStore } from '../../domain/Assessment.js';
import type { QuestionGenerationStore } from '../../domain/QuestionGeneration.js';

function getRequestId(request: FastifyRequest): string {
  return (request.headers['x-request-id'] as string | undefined) ?? 'unknown';
}

function getWorkspaceId(request: FastifyRequest, reply: FastifyReply): string | null {
  const wsId = request.headers['x-workspace-id'] as string | undefined;
  if (!wsId) {
    reply.status(400).send(
      buildErrorEnvelope({
        code: 'VALIDATION_FAILED',
        message: 'x-workspace-id header is required',
        requestId: getRequestId(request),
      }),
    );
    return null;
  }
  return wsId;
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

interface CreateShareBody {
  assessmentId: string;
  ttlSeconds?: number;
}

export interface RegisterShareRoutesOptions {
  assessmentsStore?: AssessmentsStore;
  questionStore?: QuestionGenerationStore;
}

export async function registerShareRoutes(
  app: FastifyInstance,
  service: ShareLinkService,
  options: RegisterShareRoutesOptions = {},
): Promise<void> {
  const { assessmentsStore, questionStore } = options;

  /**
   * GET /v1/shares?assessmentId=<id>
   * List all share links for an assessment (tenant-scoped).
   * Requires x-workspace-id header.
   */
  app.get('/v1/shares', async (request: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(request, reply);
    if (!workspaceId) return;

    const { assessmentId } = request.query as { assessmentId?: string };
    if (!assessmentId) {
      return reply.status(400).send(
        buildErrorEnvelope({
          code: 'VALIDATION_FAILED',
          message: 'assessmentId query param is required',
          requestId: getRequestId(request),
        }),
      );
    }

    try {
      const links = await service.listByAssessment(workspaceId, assessmentId);
      return reply.status(200).send({
        data: links.map((l) => ({
          id: l.id,
          token: l.token,
          assessmentId: l.assessmentId,
          expiresAt: l.expiresAt,
          revokedAt: l.revokedAt ?? null,
          createdAt: l.createdAt,
        })),
      });
    } catch (err) {
      handleError(err, request, reply);
    }
  });

  /**
   * POST /v1/shares
   * Create share link with expiry TTL and high-entropy token.
   * Requires x-workspace-id header.
   */
  app.post('/v1/shares', async (request: FastifyRequest, reply: FastifyReply) => {
    const workspaceId = getWorkspaceId(request, reply);
    if (!workspaceId) return;

    const body = request.body as CreateShareBody | undefined;
    if (!body?.assessmentId) {
      return reply.status(400).send(
        buildErrorEnvelope({
          code: 'VALIDATION_FAILED',
          message: 'assessmentId is required',
          requestId: getRequestId(request),
        }),
      );
    }

    try {
      const link = await service.createShareLink({
        workspaceId,
        assessmentId: body.assessmentId,
        requestId: getRequestId(request),
        ...(body.ttlSeconds !== undefined ? { ttlSeconds: body.ttlSeconds } : {}),
      });
      return reply.status(201).send({
        data: {
          id: link.id,
          token: link.token,
          assessmentId: link.assessmentId,
          expiresAt: link.expiresAt,
          createdAt: link.createdAt,
        },
      });
    } catch (err) {
      handleError(err, request, reply);
    }
  });

  /**
   * GET /v1/shares/:token
   * Public access: validate token + expiry.
   * B4 fix: returns assessment title + questions in addition to assessmentId.
   * No workspace header required (public endpoint).
   */
  app.get('/v1/shares/:token', async (request: FastifyRequest, reply: FastifyReply) => {
    const { token } = request.params as { token: string };

    try {
      const link = await service.validateToken(token, getRequestId(request));

      // B4: Fetch assessment title and questions
      let title: string | null = null;
      let questions: unknown[] = [];

      if (assessmentsStore) {
        try {
          const assessment = await assessmentsStore.getAssessmentById(
            link.workspaceId,
            link.assessmentId,
          );
          if (assessment) {
            title = assessment.title;

            if (questionStore) {
              const latestVersion = await assessmentsStore.getLatestVersion(
                link.workspaceId,
                link.assessmentId,
              );
              if (latestVersion) {
                const rawQuestions = await questionStore.getQuestionsByAssessmentVersionId(
                  link.workspaceId,
                  latestVersion.id,
                );
                questions = rawQuestions.map((q) => ({
                  id: q.id,
                  blueprintSequence: q.blueprintSequence,
                  questionType: q.questionType,
                  difficulty: q.difficulty,
                  stem: q.stem,
                  options: q.options,
                  answer: q.answer,
                  explanation: q.explanation,
                }));
              }
            }
          }
        } catch (fetchErr) {
          // Non-fatal: assessment/questions fetch failure still returns valid token response
          console.error('[shareRoutes] Failed to fetch assessment data for share:', fetchErr);
        }
      }

      return reply.status(200).send({
        data: {
          assessmentId: link.assessmentId,
          title,
          expiresAt: link.expiresAt,
          questions,
        },
      });
    } catch (err) {
      handleError(err, request, reply);
    }
  });

  /**
   * DELETE /v1/shares/:token/revoke
   * Revoke share link. Only the owning workspace can revoke.
   * Requires x-workspace-id header.
   */
  app.delete(
    '/v1/shares/:token/revoke',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const workspaceId = getWorkspaceId(request, reply);
      if (!workspaceId) return;

      const { token } = request.params as { token: string };

      try {
        const revoked = await service.revokeShareLink(token, workspaceId, getRequestId(request));
        return reply.status(200).send({
          data: {
            id: revoked.id,
            token: revoked.token,
            revokedAt: revoked.revokedAt,
          },
        });
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );
}
