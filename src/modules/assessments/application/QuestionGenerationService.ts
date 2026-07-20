/**
 * B3-03 — Structured question generation service.
 *
 * Transforms blueprint items into reviewable questions using the AI provider.
 *
 * Pipeline steps:
 * 1. Load blueprint snapshot from B3-02.
 * 2. For each blueprint item, generate a question via ProductAiService.
 * 3. Validate generated questions against the question schema.
 * 4. Apply schema repair cap (D-013): bounded retries for schema-invalid responses.
 * 5. Pin version metadata on each question (D-013).
 * 6. Persist generated questions.
 *
 * Tenant isolation: every operation requires workspaceId.
 */
import { randomUUID } from 'node:crypto';

import { ApiError } from '../../../common/errors/envelope.js';
import type {
  ProductAiService,
  ProductAiRequest,
} from '../../../infrastructure/ai/application/ProductAiService.js';
import type { AiEnv } from '../../../config/ai.env.js';
import type { BlueprintSnapshot, BlueprintSnapshotItem } from '../domain/BlueprintPipeline.js';
import type { BlueprintPipelineService } from './BlueprintPipelineService.js';
import type {
  GeneratedQuestion,
  GenerateQuestionsInput,
  GenerateQuestionsResult,
  QuestionGenerationFailure,
  QuestionGenerationStore,
  QuestionOption,
  QuestionVersionMetadata,
} from '../domain/QuestionGeneration.js';

// ---- Service options ----

export interface QuestionGenerationServiceOptions {
  store: QuestionGenerationStore;
  blueprintService: BlueprintPipelineService;
  aiService: ProductAiService;
  env: AiEnv;
  clock?: () => Date;
}

// ---- Service ----

export class QuestionGenerationService {
  private readonly store: QuestionGenerationStore;
  private readonly blueprintService: BlueprintPipelineService;
  private readonly aiService: ProductAiService;
  private readonly env: AiEnv;
  private readonly clock: () => Date;

  constructor(options: QuestionGenerationServiceOptions) {
    this.store = options.store;
    this.blueprintService = options.blueprintService;
    this.aiService = options.aiService;
    this.env = options.env;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Generate questions from a blueprint.
   *
   * Returns cached questions if they already exist for this assessment version.
   */
  async generateQuestions(input: GenerateQuestionsInput): Promise<GenerateQuestionsResult> {
    const { workspaceId, assessmentVersionId, requestId } = input;

    // ---- 1. Check for existing questions ----
    const existing = await this.store.getQuestionsByAssessmentVersionId(
      workspaceId,
      assessmentVersionId,
    );
    if (existing.length > 0) {
      return {
        questions: existing,
        totalSchemaRepairAttempts: 0,
        hasFailures: false,
        failures: [],
      };
    }

    // ---- 2. Load blueprint snapshot ----
    const blueprint = await this.blueprintService.getBlueprint(workspaceId, assessmentVersionId);
    if (!blueprint) {
      throw new ApiError({
        code: 'RESOURCE_NOT_FOUND',
        message: 'Blueprint snapshot not found. Run blueprint pipeline first.',
        requestId,
      });
    }

    // ---- 3. Generate questions for each blueprint item ----
    const questions: GeneratedQuestion[] = [];
    const failures: QuestionGenerationFailure[] = [];
    let totalSchemaRepairAttempts = 0;

    for (const item of blueprint.items) {
      try {
        const result = await this.generateQuestionFromItem(
          workspaceId,
          assessmentVersionId,
          item,
          blueprint,
        );
        questions.push(result.question);
        totalSchemaRepairAttempts += result.schemaRepairAttempts;
      } catch (err) {
        if (err instanceof SchemaRepairExhaustedError) {
          failures.push({
            blueprintSequence: item.sequence,
            reason: 'schema_repair_exhausted',
            message: err.message,
          });
          totalSchemaRepairAttempts += err.attempts;
        } else if (err instanceof InsufficientSourceForQuestionError) {
          failures.push({
            blueprintSequence: item.sequence,
            reason: 'insufficient_source',
            message: err.message,
          });
        } else {
          failures.push({
            blueprintSequence: item.sequence,
            reason: 'provider_error',
            message: err instanceof Error ? err.message : 'Unknown error',
          });
        }
      }
    }

    // ---- 4. Persist successful questions ----
    if (questions.length > 0) {
      await this.store.saveQuestions(questions);
    }

    return {
      questions,
      totalSchemaRepairAttempts,
      hasFailures: failures.length > 0,
      failures,
    };
  }

  /**
   * Retrieve existing questions for an assessment version.
   */
  async getQuestions(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<GeneratedQuestion[]> {
    return this.store.getQuestionsByAssessmentVersionId(workspaceId, assessmentVersionId);
  }

  // ---- Private helpers ----

  private async generateQuestionFromItem(
    workspaceId: string,
    assessmentVersionId: string,
    item: BlueprintSnapshotItem,
    blueprint: BlueprintSnapshot,
  ): Promise<{ question: GeneratedQuestion; schemaRepairAttempts: number }> {
    // Build prompt for this question
    const prompt = this.buildQuestionPrompt(item);

    // Call AI service
    const aiRequest: ProductAiRequest =
      workspaceId && assessmentVersionId
        ? {
            workspaceId,
            actorId: 'system',
            promptTemplateId: 'question-generation-v1',
            schemaVersion: 1,
            prompt,
            schema: QUESTION_OUTPUT_SCHEMA,
            tokenEstimateHint: null,
            signals: {
              questionType: item.questionType,
              difficulty: item.difficulty,
              sequence: item.sequence,
            },
          }
        : (() => {
            throw new Error('Invalid workspace or assessment version');
          })();

    const aiResult = await this.aiService.run(aiRequest);

    if (aiResult.status === 'failed') {
      if (aiResult.outcome === 'schema_invalid') {
        throw new SchemaRepairExhaustedError(
          `Schema repair exhausted for question at sequence ${item.sequence}`,
          aiResult.schemaRepairAttempts,
        );
      }
      throw new ProviderError(
        `AI provider error for question at sequence ${item.sequence}: ${aiResult.outcome}`,
      );
    }

    // Parse the validated response
    const parsed = aiResult.validated;
    const question = this.buildQuestionFromAiResponse(
      workspaceId,
      assessmentVersionId,
      item,
      parsed,
      blueprint.blueprintSchemaVersion,
      aiResult.providerModelId,
      aiResult.schemaRepairAttempts,
      aiResult.latencyMs,
    );

    return {
      question,
      schemaRepairAttempts: aiResult.schemaRepairAttempts,
    };
  }

  private buildQuestionPrompt(item: BlueprintSnapshotItem): string {
    const sourceContext =
      item.citationIds.length > 0 ? `\nSource passages: ${item.citationIds.join(', ')}` : '';

    return `Generate a ${item.difficulty} ${item.questionType} question.
${item.topicHint ? `Topic: ${item.topicHint}` : ''}
${item.cognitiveLevel ? `Cognitive level: ${item.cognitiveLevel}` : ''}
${sourceContext}

Return a JSON object with:
- "stem": the question text
- "options": array of {key, text} (for MC: A,B,C,D; for T/F: true,false)
- "answer": the correct answer (option key for MC, text for others)
- "explanation": why the answer is correct
- "sourceIds": array of source passage IDs used`;
  }

  private buildQuestionFromAiResponse(
    workspaceId: string,
    assessmentVersionId: string,
    item: BlueprintSnapshotItem,
    aiResponse: Record<string, unknown>,
    blueprintSchemaVersion: string,
    providerModelId: string,
    schemaRepairAttempts: number,
    latencyMs: number,
  ): GeneratedQuestion {
    const stem = typeof aiResponse['stem'] === 'string' ? aiResponse['stem'] : '';
    const rawOptions = Array.isArray(aiResponse['options']) ? aiResponse['options'] : [];
    const options: QuestionOption[] = rawOptions.map((opt: unknown) => {
      if (typeof opt === 'object' && opt !== null) {
        const obj = opt as Record<string, unknown>;
        return {
          key: typeof obj['key'] === 'string' ? obj['key'] : '',
          text: typeof obj['text'] === 'string' ? obj['text'] : '',
        };
      }
      return { key: '', text: '' };
    });
    const answer = typeof aiResponse['answer'] === 'string' ? aiResponse['answer'] : '';
    const explanation =
      typeof aiResponse['explanation'] === 'string' ? aiResponse['explanation'] : '';
    const sourceIds = Array.isArray(aiResponse['sourceIds'])
      ? (aiResponse['sourceIds'] as unknown[]).filter((id): id is string => typeof id === 'string')
      : [];

    const versionMetadata: QuestionVersionMetadata = {
      blueprintSchemaVersion,
      providerModelId,
      promptTemplateId: 'question-generation-v1',
      schemaRepairAttempts,
      latencyMs,
    };

    return {
      id: randomUUID(),
      assessmentVersionId,
      workspaceId,
      blueprintSequence: item.sequence,
      questionType: item.questionType,
      difficulty: item.difficulty,
      stem,
      options,
      answer,
      explanation,
      sourceIds,
      versionMetadata,
      createdAt: this.clock().toISOString(),
    };
  }
}

// ---- Custom errors ----

class SchemaRepairExhaustedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
  ) {
    super(message);
    this.name = 'SchemaRepairExhaustedError';
  }
}

class InsufficientSourceForQuestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientSourceForQuestionError';
  }
}

class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

// ---- Factory ----

export function createQuestionGenerationService(
  options: QuestionGenerationServiceOptions,
): QuestionGenerationService {
  return new QuestionGenerationService(options);
}

// ---- JSON Schema for question output ----

export const QUESTION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['stem', 'options', 'answer', 'explanation', 'sourceIds'],
  properties: {
    stem: { type: 'string', minLength: 1 },
    options: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'text'],
        properties: {
          key: { type: 'string', minLength: 1 },
          text: { type: 'string', minLength: 1 },
        },
      },
    },
    answer: { type: 'string', minLength: 1 },
    explanation: { type: 'string' },
    sourceIds: {
      type: 'array',
      items: { type: 'string' },
    },
  },
};
