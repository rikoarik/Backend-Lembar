/**
 * Handler for question_regeneration jobs.
 *
 * Regenerates a single question using QuestionGenerationService.
 * Stores as replacement candidate for teacher review.
 */
import type { JobHandler, JobContext, JobResult } from '../domain/JobHandler.js';
import type { QuestionGenerationService } from '../../../modules/assessments/application/QuestionGenerationService.js';
import type { QuestionType, Difficulty } from '../../../modules/assessments/domain/Assessment.js';

export interface QuestionRegenerationHandlerOptions {
  questionGenerationService: QuestionGenerationService;
}

export class QuestionRegenerationHandler implements JobHandler {
  readonly kind = 'question_regeneration' as const;
  private readonly questionGenerationService: QuestionGenerationService;

  constructor(options: QuestionRegenerationHandlerOptions) {
    this.questionGenerationService = options.questionGenerationService;
  }

  async handle(context: JobContext): Promise<JobResult> {
    const { payload, workspaceId, jobId, signal } = context;

    console.log(
      `[QuestionRegenerationHandler] Processing job ${jobId} for workspace ${workspaceId}`,
    );

    try {
      const assessmentVersionId = String(payload.assessmentVersionId ?? payload.assessmentId ?? jobId);
      const questionId = String(payload.questionId ?? '');
      const feedback = String(payload.feedback ?? payload.reason ?? '');

      if (signal.aborted) {
        return { status: 'failure', error: { code: 'CANCELLED', message: 'Job was cancelled' } };
      }

      // Regenerate: create a single-item blueprint with same params as original question
      const result = await this.questionGenerationService.generateQuestions({
        workspaceId,
        assessmentVersionId: `${assessmentVersionId}-regen-${questionId.slice(0, 8)}`,
        blueprintItems: [
          {
            sequence: 0,
            questionType: (payload.questionType ?? 'multiple_choice') as QuestionType,
            difficulty: (payload.difficulty ?? 'medium') as Difficulty,
            cognitiveLevel: null,
            topicHint: (payload.topicHint ?? payload.topic ?? feedback) as string | null,
            outcomeId: null,
            sourceUploadId: null,
            citationIds: [],
          },
        ],
        blueprintSchemaVersion: '1.0',
        coverageTargets: { minTotalItems: 1, maxTotalItems: 1 },
        requestId: jobId,
      });

      const regeneratedQuestion = result.questions[0];

      return {
        status: 'success',
        output: {
          questionId,
          regenerated: true,
          needsReview: true,
          newQuestionId: regeneratedQuestion?.id ?? null,
          hasFailures: result.hasFailures,
        },
      };
    } catch (err) {
      if (signal.aborted) {
        return { status: 'failure', error: { code: 'CANCELLED', message: 'Job was cancelled' } };
      }
      console.error(`[QuestionRegenerationHandler] Error in job ${jobId}:`, err);
      return {
        status: 'failure',
        error: {
          code: 'REGENERATION_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
