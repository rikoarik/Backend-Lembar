/**
 * B4-01 — HTTP routes for question review, edit, and audit.
 * B4-02 — Targeted regeneration (candidate create + accept).
 * B4-03 — Optimistic conflict handling via ETag / If-Match.
 * B4-04 — Immutable finalization.
 *
 * Route base: /v1/workspaces/:workspaceId/assessments/:assessmentId/versions/:versionId/questions
 *
 * Endpoints:
 *   GET    …/questions/:qId                   — get question + ETag header
 *   PATCH  …/questions/:qId                   — edit (If-Match required)
 *   DELETE …/questions/:qId                   — soft-delete (audit)
 *   GET    …/questions/:qId/audit             — audit trail
 *   POST   …/questions/:qId/regenerate        — create candidate
 *   PATCH  …/questions/:qId/accept-candidate  — swap candidate → active
 *   POST   …/versions/:versionId/finalize     — immutable finalization
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { ApiError, buildErrorEnvelope } from '../../../../common/errors/envelope.js';
import {
  QuestionNotFoundError,
  QuestionEtagMismatchError,
  QuestionFinalizedError,
  QuestionNoCandidateError,
  AssessmentVersionNotFinalizedError,
  QuestionsPendingError,
} from '../../application/QuestionReviewService.js';
import type { QuestionReviewService } from '../../application/QuestionReviewService.js';
import type { FinalizationService } from '../../application/FinalizationService.js';

function getRequestId(request: FastifyRequest): string {
  return (request.headers['x-request-id'] as string | undefined) ?? 'unknown';
}

function handleError(err: unknown, request: FastifyRequest, reply: FastifyReply): void {
  const requestId = getRequestId(request);

  if (err instanceof QuestionNotFoundError) {
    return void reply.status(404).send(
      buildErrorEnvelope({ code: 'RESOURCE_NOT_FOUND', message: err.message, requestId }),
    );
  }
  if (err instanceof QuestionEtagMismatchError) {
    return void reply.status(409).send(
      buildErrorEnvelope({ code: 'STATE_CONFLICT', message: err.message, requestId }),
    );
  }
  if (err instanceof QuestionFinalizedError) {
    return void reply.status(403).send(
      buildErrorEnvelope({ code: 'PERMISSION_DENIED', message: err.message, requestId }),
    );
  }
  if (err instanceof QuestionNoCandidateError) {
    return void reply.status(404).send(
      buildErrorEnvelope({ code: 'RESOURCE_NOT_FOUND', message: err.message, requestId }),
    );
  }
  if (err instanceof QuestionsPendingError) {
    return void reply.status(422).send(
      buildErrorEnvelope({ code: 'VALIDATION_FAILED', message: err.message, requestId }),
    );
  }
  if (err instanceof AssessmentVersionNotFinalizedError) {
    return void reply.status(404).send(
      buildErrorEnvelope({ code: 'RESOURCE_NOT_FOUND', message: err.message, requestId }),
    );
  }
  if (err instanceof ApiError) {
    return void reply.status(err.status).send(err.toEnvelope());
  }
  reply.status(500).send(
    buildErrorEnvelope({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId }),
  );
}

interface EditQuestionBody {
  stem?: string;
  answer?: string;
  explanation?: string;
  options?: Array<{ key: string; text: string }>;
  status?: string;
}

interface RegenerateBody {
  idempotencyKey?: string;
}

export async function registerQuestionReviewRoutes(
  app: FastifyInstance,
  reviewService: QuestionReviewService,
  finalizationService: FinalizationService,
): Promise<void> {
  const BASE =
    '/v1/workspaces/:workspaceId/assessments/:assessmentId/versions/:versionId/questions';

  // ── GET question + ETag header (B4-01, B4-03) ─────────────────────────────
  app.get(`${BASE}/:qId`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId, qId } = request.params as {
      workspaceId: string;
      assessmentId: string;
      versionId: string;
      qId: string;
    };
    try {
      const q = await reviewService.getQuestion(workspaceId, qId);
      reply.header('ETag', `"${q.etag}"`);
      return reply.status(200).send({ question: q });
    } catch (err) {
      handleError(err, request, reply);
    }
  });

  // ── PATCH edit question (B4-01 versioned edit, B4-03 If-Match) ────────────
  app.patch(`${BASE}/:qId`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId, qId } = request.params as {
      workspaceId: string;
      assessmentId: string;
      versionId: string;
      qId: string;
    };
    const ifMatch = request.headers['if-match'] as string | undefined;
    const body = (request.body ?? {}) as EditQuestionBody;
    const actorUserId = (request.headers['x-actor-user-id'] as string | undefined) ?? 'system';

    try {
      // Extract etag value from If-Match header (strip quotes if present)
      const expectedEtag = ifMatch ? ifMatch.replace(/^"|"$/g, '') : undefined;

      const edits: import('../../domain/QuestionReview.js').EditReviewedQuestionInput = {
        ...(body.stem !== undefined ? { stem: body.stem } : {}),
        ...(body.answer !== undefined ? { answer: body.answer } : {}),
        ...(body.explanation !== undefined ? { explanation: body.explanation } : {}),
        ...(body.options !== undefined ? { options: body.options } : {}),
        ...(body.status !== undefined
          ? { status: body.status as 'pending' | 'accepted' | 'rejected' }
          : {}),
        ...(expectedEtag !== undefined ? { expectedEtag } : {}),
      };
      const updated = await reviewService.editQuestion(workspaceId, qId, edits, actorUserId);
      reply.header('ETag', `"${updated.etag}"`);
      return reply.status(200).send({ question: updated });
    } catch (err) {
      handleError(err, request, reply);
    }
  });

  // ── DELETE question (B4-01) ────────────────────────────────────────────────
  app.delete(`${BASE}/:qId`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId, qId } = request.params as {
      workspaceId: string;
      assessmentId: string;
      versionId: string;
      qId: string;
    };
    const actorUserId = (request.headers['x-actor-user-id'] as string | undefined) ?? 'system';

    try {
      await reviewService.deleteQuestion(workspaceId, qId, actorUserId);
      return reply.status(204).send();
    } catch (err) {
      handleError(err, request, reply);
    }
  });

  // ── GET audit trail (B4-01) ───────────────────────────────────────────────
  app.get(`${BASE}/:qId/audit`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId, qId } = request.params as {
      workspaceId: string;
      assessmentId: string;
      versionId: string;
      qId: string;
    };

    try {
      const log = await reviewService.getAuditLog(workspaceId, qId);
      return reply.status(200).send({ auditLog: log });
    } catch (err) {
      handleError(err, request, reply);
    }
  });

  // ── POST regenerate — create candidate (B4-02) ────────────────────────────
  app.post(`${BASE}/:qId/regenerate`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId, qId } = request.params as {
      workspaceId: string;
      assessmentId: string;
      versionId: string;
      qId: string;
    };
    const body = (request.body ?? {}) as RegenerateBody;
    const actorUserId = (request.headers['x-actor-user-id'] as string | undefined) ?? 'system';

    try {
      const result = await reviewService.createCandidate(
        workspaceId,
        qId,
        actorUserId,
        body.idempotencyKey,
      );
      return reply.status(result.created ? 201 : 200).send({
        original: result.original,
        candidate: result.candidate,
      });
    } catch (err) {
      handleError(err, request, reply);
    }
  });

  // ── PATCH accept-candidate (B4-02) ────────────────────────────────────────
  app.patch(
    `${BASE}/:qId/accept-candidate`,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, qId } = request.params as {
        workspaceId: string;
        assessmentId: string;
        versionId: string;
        qId: string;
      };
      const actorUserId = (request.headers['x-actor-user-id'] as string | undefined) ?? 'system';

      try {
        const accepted = await reviewService.acceptCandidate(workspaceId, qId, actorUserId);
        reply.header('ETag', `"${accepted.etag}"`);
        return reply.status(200).send({ question: accepted });
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );

  // ── PATCH reject-candidate (B4-02) ────────────────────────────────────────
  app.patch(
    `${BASE}/:qId/reject-candidate`,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, qId } = request.params as {
        workspaceId: string;
        assessmentId: string;
        versionId: string;
        qId: string;
      };
      const actorUserId = (request.headers['x-actor-user-id'] as string | undefined) ?? 'system';

      try {
        const original = await reviewService.rejectCandidate(workspaceId, qId, actorUserId);
        reply.header('ETag', `"${original.etag}"`);
        return reply.status(200).send({ question: original });
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );

  // ── POST finalize (B4-04) ─────────────────────────────────────────────────
  app.post(
    '/v1/workspaces/:workspaceId/assessments/:assessmentId/versions/:versionId/finalize',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, versionId } = request.params as {
        workspaceId: string;
        assessmentId: string;
        versionId: string;
      };
      const actorUserId = (request.headers['x-actor-user-id'] as string | undefined) ?? 'system';

      try {
        const result = await finalizationService.finalizeAssessmentVersion(
          workspaceId,
          versionId,
          actorUserId,
        );
        return reply.status(200).send(result);
      } catch (err) {
        handleError(err, request, reply);
      }
    },
  );
}
