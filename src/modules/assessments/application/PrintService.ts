/**
 * B5-01 — Print service: builds a versioned PrintDocument DTO from
 * an accepted/finalized assessment.
 *
 * Tenant isolation: every public method requires workspaceId.
 * No external I/O — pure domain assembly. Storage/PDF is B5-02's concern.
 */
import { randomUUID } from 'node:crypto';

import { PRINT_DTO_VERSION, type PrintDocument, type PrintQuestion } from '../domain/PrintDocument.js';
import type { AssessmentsStore } from '../domain/Assessment.js';
import type { QuestionReviewStore } from '../domain/QuestionReview.js';
import { ApiError } from '../../../common/errors/envelope.js';

export interface PrintServiceOptions {
  assessmentsStore: AssessmentsStore;
  reviewStore: QuestionReviewStore;
  clock?: () => Date;
}

export class PrintService {
  private readonly clock: () => Date;

  constructor(private readonly options: PrintServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Build a PrintDocument DTO for the given assessment.
   *
   * @throws ApiError RESOURCE_NOT_FOUND (404) if assessment not found for this workspace
   * @throws ApiError STATE_CONFLICT (409) if assessment is not finalized
   */
  async buildPrintDocument(
    workspaceId: string,
    assessmentId: string,
    requestId: string,
  ): Promise<PrintDocument> {
    const assessment = await this.options.assessmentsStore.getAssessmentById(workspaceId, assessmentId);
    if (!assessment) {
      throw new ApiError({
        code: 'RESOURCE_NOT_FOUND',
        message: `Assessment not found: ${assessmentId}`,
        status: 404,
        requestId,
      });
    }

    // Get latest version
    const version = await this.options.assessmentsStore.getLatestVersion(
      workspaceId,
      assessmentId,
    );
    if (!version) {
      throw new ApiError({
        code: 'RESOURCE_NOT_FOUND',
        message: 'Assessment version not found',
        status: 404,
        requestId,
      });
    }

    // Must be finalized to print
    const finalization = await this.options.reviewStore.getFinalization(
      workspaceId,
      version.id,
    );
    if (!finalization) {
      throw new ApiError({
        code: 'STATE_CONFLICT',
        message: 'Assessment must be finalized before printing',
        status: 409,
        requestId,
      });
    }

    // Fetch accepted questions
    const questions = await this.options.reviewStore.listByAssessmentVersion(
      workspaceId,
      version.id,
    );

    const printQuestions: PrintQuestion[] = questions
      .filter((q) => q.status === 'accepted')
      .sort((a, b) => a.blueprintSequence - b.blueprintSequence)
      .map((q) => ({
        sequence: q.blueprintSequence,
        questionType: q.questionType,
        difficulty: q.difficulty,
        stem: q.stem,
        options: q.options.map((o) => ({ key: o.key, text: o.text })),
        answer: q.answer,
        explanation: q.explanation,
      }));

    const doc: PrintDocument = {
      meta: {
        dtoVersion: PRINT_DTO_VERSION,
        assessmentId: assessment.id,
        assessmentVersion: version.version,
        workspaceId: assessment.workspaceId,
        title: assessment.title,
        finalizedAt: finalization.finalizedAt,
        generatedAt: this.clock().toISOString(),
      },
      questions: printQuestions,
    };

    return doc;
  }
}
