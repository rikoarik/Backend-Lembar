/**
 * Handler for assessment_generation jobs.
 *
 * Wires QuestionGenerationService → BlueprintPipelineService → ProductAiService (HermesAdapter).
 * Falls back gracefully: if AI call fails, returns partial result so the job doesn't hang.
 */
import type { JobHandler, JobContext, JobResult } from '../domain/JobHandler.js';
import type { QuestionGenerationService } from '../../../modules/assessments/application/QuestionGenerationService.js';
import type { QuestionReviewService } from '../../../modules/assessments/application/QuestionReviewService.js';
import type { QuestionType, Difficulty } from '../../../modules/assessments/domain/Assessment.js';

export interface AssessmentGenerationHandlerOptions {
  questionGenerationService: QuestionGenerationService;
  questionReviewService?: QuestionReviewService;
}

export class AssessmentGenerationHandler implements JobHandler {
  readonly kind = 'assessment_generation' as const;
  private readonly questionGenerationService: QuestionGenerationService;
  private readonly questionReviewService: QuestionReviewService | undefined;

  constructor(options: AssessmentGenerationHandlerOptions) {
    this.questionGenerationService = options.questionGenerationService;
    this.questionReviewService = options.questionReviewService;
  }

  async handle(context: JobContext): Promise<JobResult> {
    const { payload, workspaceId, jobId, signal } = context;

    console.log(
      `[AssessmentGenerationHandler] Processing job ${jobId} for workspace ${workspaceId}`,
    );

    try {
      // Extract blueprint from payload
      const assessmentVersionId = String(payload.assessmentVersionId ?? payload.assessmentId ?? jobId);
      const blueprintItems = Array.isArray(payload.blueprintItems) ? payload.blueprintItems : [];
      const blueprintSchemaVersion = String(payload.blueprintSchemaVersion ?? '1.0');

      // Map raw payload items to typed blueprint items
      const typedBlueprint = blueprintItems.map((item: any, idx: number) => ({
        sequence: Number(item.sequence ?? idx),
        questionType: (item.questionType ?? item.question_type ?? 'multiple_choice') as QuestionType,
        difficulty: (item.difficulty ?? 'medium') as Difficulty,
        cognitiveLevel: (item.cognitiveLevel ?? item.cognitive_level ?? null) as string | null,
        topicHint: (item.topicHint ?? item.topic_hint ?? null) as string | null,
        outcomeId: (item.outcomeId ?? item.outcome_id ?? null) as string | null,
        sourceUploadId: (item.sourceUploadId ?? item.source_upload_id ?? null) as string | null,
        citationIds: Array.isArray(item.citationIds) ? item.citationIds : [],
      }));

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

      console.log(
        `[AssessmentGenerationHandler] Job ${jobId}: generated=${result.questions.length}, failed=${failed}`,
      );

      return {
        status: failed < typedBlueprint.length ? 'success' : 'failure',
        output: {
          assessmentVersionId,
          questionsGenerated: result.questions.length,
          questionsSucceeded: succeeded.length,
          questionsFailed: failed,
          totalSchemaRepairAttempts: result.totalSchemaRepairAttempts,
          hasFailures: result.hasFailures,
        },
      };
    } catch (err) {
      if (signal.aborted) {
        return { status: 'failure', error: { code: 'CANCELLED', message: 'Job was cancelled' } };
      }
      console.error(`[AssessmentGenerationHandler] Error in job ${jobId}:`, err);
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
