/**
 * Handler for assessment_generation jobs.
 *
 * Wires QuestionGenerationService → BlueprintPipelineService → ProductAiService (HermesAdapter).
 * Falls back gracefully: if AI call fails, returns partial result so the job doesn't hang.
 *
 * B1 fix: after generation completes, update assessment status to 'ready' (success) or 'failed'
 * (total failure) via assessmentsStore.
 */
import type { JobHandler, JobContext, JobResult } from '../domain/JobHandler.js';
import type { QuestionGenerationService } from '../../../modules/assessments/application/QuestionGenerationService.js';
import type { QuestionReviewService } from '../../../modules/assessments/application/QuestionReviewService.js';
import type {
  QuestionType,
  Difficulty,
  AssessmentsStore,
} from '../../../modules/assessments/domain/Assessment.js';
import {
  normalizeQuestionGenerationContext,
  normalizeQuestionImageGenerationSettings,
} from '../../../modules/assessments/domain/QuestionGeneration.js';

export interface AssessmentGenerationHandlerOptions {
  questionGenerationService: QuestionGenerationService;
  questionReviewService?: QuestionReviewService;
  assessmentsStore?: AssessmentsStore;
}

export class AssessmentGenerationHandler implements JobHandler {
  readonly kind = 'assessment_generation' as const;
  private readonly questionGenerationService: QuestionGenerationService;
  private readonly questionReviewService: QuestionReviewService | undefined;
  private readonly assessmentsStore: AssessmentsStore | undefined;

  constructor(options: AssessmentGenerationHandlerOptions) {
    this.questionGenerationService = options.questionGenerationService;
    this.questionReviewService = options.questionReviewService;
    this.assessmentsStore = options.assessmentsStore;
  }

  async handle(context: JobContext): Promise<JobResult> {
    const { payload, workspaceId, jobId, signal } = context;

    console.log(
      `[AssessmentGenerationHandler] Processing job ${jobId} for workspace ${workspaceId}`,
    );

    // assessmentId is the parent assessment to update status on (separate from assessmentVersionId)
    const assessmentId = String(payload.assessmentId ?? '');

    try {
      // Extract blueprint from payload
      const assessmentVersionId = String(payload.assessmentVersionId ?? payload.assessmentId ?? jobId);
      const blueprintItems = Array.isArray(payload.blueprintItems) ? payload.blueprintItems : [];
      const blueprintSchemaVersion = String(payload.blueprintSchemaVersion ?? '1.0');
      const imageGeneration = normalizeQuestionImageGenerationSettings(payload.imageGeneration);
      const generationContext = normalizeQuestionGenerationContext(payload.generationContext);

      // Map raw payload items to typed blueprint items.
      const typedBlueprint = blueprintItems.map((item: unknown, idx: number) => {
        const raw = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
        const stringOrNull = (value: unknown) => (typeof value === 'string' ? value : null);
        return {
          sequence: Number(raw.sequence ?? idx),
          questionType: (raw.questionType ?? raw.question_type ?? 'multiple_choice') as QuestionType,
          difficulty: (raw.difficulty ?? 'medium') as Difficulty,
          cognitiveLevel: stringOrNull(raw.cognitiveLevel ?? raw.cognitive_level),
          topicHint: stringOrNull(raw.topicHint ?? raw.topic_hint),
          outcomeId: stringOrNull(raw.outcomeId ?? raw.outcome_id),
          sourceUploadId: stringOrNull(raw.sourceUploadId ?? raw.source_upload_id),
          citationIds: Array.isArray(raw.citationIds)
            ? raw.citationIds.filter((id): id is string => typeof id === 'string')
            : [],
        };
      });

      // If no blueprint items, generate a default set of 5 questions
      if (typedBlueprint.length === 0) {
        for (let i = 0; i < 5; i++) {
          typedBlueprint.push({
            sequence: i,
            questionType: 'multiple_choice',
            difficulty: 'medium',
            cognitiveLevel: null,
            topicHint: String(payload.topicHint ?? payload.topic ?? ''),
            outcomeId: null,
            sourceUploadId: null,
            citationIds: [],
          });
        }
      }

      // Check abort signal before heavy work
      if (signal.aborted) {
        return { status: 'failure', error: { code: 'CANCELLED', message: 'Job was cancelled' } };
      }

      const result = await this.questionGenerationService.generateQuestions({
        workspaceId,
        assessmentVersionId,
        blueprintItems: typedBlueprint,
        blueprintSchemaVersion,
        coverageTargets: {
          minTotalItems: typedBlueprint.length,
          maxTotalItems: typedBlueprint.length,
        },
        requestId: jobId,
        jobId,
        imageGeneration,
        generationContext,
        ...(context.reportProgress ? { onProgress: context.reportProgress } : {}),
      });

      const succeeded = result.questions.filter((q) => !result.failures.some((f) => f.blueprintSequence === q.blueprintSequence));
      if (this.questionReviewService) {
        await Promise.all(
          succeeded.map((question) =>
            this.questionReviewService!.importQuestion(question, context.actorId),
          ),
        );
      }
      const failed = result.failures.length;
      const isSuccess = failed < typedBlueprint.length;

      console.log(
        `[AssessmentGenerationHandler] Job ${jobId}: generated=${result.questions.length}, failed=${failed}`,
      );

      // B1: Update assessment status to 'ready' on success, 'failed' on total failure
      if (assessmentId && this.assessmentsStore) {
        try {
          await this.assessmentsStore.updateAssessment({
            id: assessmentId,
            workspaceId,
            status: isSuccess ? 'ready' : 'failed',
          });
          console.log(
            `[AssessmentGenerationHandler] Assessment ${assessmentId} status → ${isSuccess ? 'ready' : 'failed'}`,
          );
        } catch (updateErr) {
          // Non-fatal: log but don't fail the job result over a status update error
          console.error(
            `[AssessmentGenerationHandler] Failed to update assessment ${assessmentId} status:`,
            updateErr,
          );
        }
      }

      return {
        status: isSuccess ? 'success' : 'failure',
        output: {
          assessmentVersionId,
          questionsGenerated: result.questions.length,
          questionsSucceeded: succeeded.length,
          questionsFailed: failed,
          totalSchemaRepairAttempts: result.totalSchemaRepairAttempts,
          imagesGenerated: result.imagesGenerated,
          hasFailures: result.hasFailures,
        },
      };
    } catch (err) {
      if (signal.aborted) {
        return { status: 'failure', error: { code: 'CANCELLED', message: 'Job was cancelled' } };
      }
      console.error(`[AssessmentGenerationHandler] Error in job ${jobId}:`, err);

      // B1: Mark assessment failed on exception too
      if (assessmentId && this.assessmentsStore) {
        try {
          await this.assessmentsStore.updateAssessment({
            id: assessmentId,
            workspaceId,
            status: 'failed',
          });
        } catch { /* best-effort */ }
      }

      return {
        status: 'failure',
        error: {
          code: 'GENERATION_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
