import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { JobContext, JobResult } from '../../../src/infrastructure/queue/domain/JobHandler.js';
import { AssessmentGenerationHandler } from '../../../src/infrastructure/queue/handlers/AssessmentGenerationHandler.js';
import { QuestionReviewService } from '../../../src/modules/assessments/application/QuestionReviewService.js';
import { InMemoryQuestionReviewStore } from '../../../src/modules/assessments/persistence/InMemoryQuestionReviewStore.js';

function makeContext(payload: Record<string, unknown>): JobContext {
  return {
    jobId: 'job-test-import',
    workspaceId: 'ws-import-test',
    actorId: 'actor-import',
    attempt: 1,
    payload,
    signal: new AbortController().signal,
  };
}

function makeQuestionGenerationService() {
  return {
    generateQuestions: vi.fn(async (input: {
      workspaceId: string;
      assessmentVersionId: string;
      blueprintItems: Array<{ sequence: number }>;
    }) => ({
      questions: input.blueprintItems.map((item) => ({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        assessmentVersionId: input.assessmentVersionId,
        blueprintSequence: item.sequence,
        questionType: 'multiple_choice' as const,
        difficulty: 'medium' as const,
        stem: `Soal ${item.sequence}`,
        options: [{ key: 'A', text: 'Jawaban A' }],
        answer: 'A',
        explanation: 'Penjelasan',
        sourceIds: [`p-${item.sequence}`],
        versionMetadata: {
          blueprintSchemaVersion: '1.0',
          providerModelId: 'mock',
          promptTemplateId: 'question-generation-v1',
          schemaRepairAttempts: 0,
          latencyMs: 0,
        },
        createdAt: new Date().toISOString(),
      })),
      totalSchemaRepairAttempts: 0,
      hasFailures: false,
      failures: [],
    })),
  };
}

describe('AssessmentGenerationHandler importQuestion wiring', () => {
  it('marks the persisted assessment failed when every question fails', async () => {
    const updateAssessment = vi.fn(async () => undefined);
    const questionGenerationService = makeQuestionGenerationService();
    questionGenerationService.generateQuestions.mockResolvedValue({
      questions: [],
      totalSchemaRepairAttempts: 0,
      hasFailures: true,
      failures: [{ blueprintSequence: 0, reason: 'provider_error', message: 'forced' }],
    });
    const handler = new AssessmentGenerationHandler({
      questionGenerationService: questionGenerationService as never,
      assessmentsStore: { updateAssessment } as never,
    });

    const result = await handler.handle(makeContext({
      assessmentId: 'assessment-1',
      assessmentVersionId: 'version-1',
      blueprintItems: [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
    }));

    expect(result.status).toBe('failure');
    expect(updateAssessment).toHaveBeenCalledWith({
      id: 'assessment-1', workspaceId: 'ws-import-test', status: 'failed',
    });
  });

  it('imports every successful generated question into the review store', async () => {
    const reviewStore = new InMemoryQuestionReviewStore();
    const reviewService = new QuestionReviewService({ store: reviewStore });
    const questionGenerationService = makeQuestionGenerationService();
    const handler = new AssessmentGenerationHandler({
      questionGenerationService: questionGenerationService as never,
      questionReviewService: reviewService,
    });

    const versionId = randomUUID();
    const result: JobResult = await handler.handle(
      makeContext({
        assessmentVersionId: versionId,
        blueprintItems: [
          { sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' },
          { sequence: 1, questionType: 'multiple_choice', difficulty: 'medium' },
        ],
      }),
    );

    expect(result.status).toBe('success');
    const reviewed = await reviewStore.listByAssessmentVersion('ws-import-test', versionId);
    expect(reviewed).toHaveLength(2);
    expect(reviewed.every((q) => q.status === 'pending')).toBe(true);
  });

  it('does not require QuestionReviewService to succeed', async () => {
    const questionGenerationService = makeQuestionGenerationService();
    const handler = new AssessmentGenerationHandler({
      questionGenerationService: questionGenerationService as never,
    });

    const result = await handler.handle(
      makeContext({
        assessmentVersionId: randomUUID(),
        blueprintItems: [{ sequence: 0, questionType: 'short_answer', difficulty: 'easy' }],
      }),
    );
    expect(result.status).toBe('success');
  });

  it('skips import for blueprint sequences that failed generation', async () => {
    const reviewStore = new InMemoryQuestionReviewStore();
    const reviewService = new QuestionReviewService({ store: reviewStore });
    const questionGenerationService = makeQuestionGenerationService();
    questionGenerationService.generateQuestions.mockResolvedValue({
      questions: [
        {
          id: 'q-success',
          workspaceId: 'ws-import-test',
          assessmentVersionId: 'ver-1',
          blueprintSequence: 0,
          questionType: 'multiple_choice',
          difficulty: 'medium',
          stem: 'A',
          options: [{ key: 'A', text: 'a' }],
          answer: 'A',
          explanation: '',
          sourceIds: [],
          versionMetadata: {
            blueprintSchemaVersion: '1.0',
            providerModelId: 'mock',
            promptTemplateId: 'question-generation-v1',
            schemaRepairAttempts: 0,
            latencyMs: 0,
          },
          createdAt: new Date().toISOString(),
        },
      ],
      totalSchemaRepairAttempts: 0,
      hasFailures: true,
      failures: [
        {
          blueprintSequence: 1,
          reason: 'provider_error',
          message: 'forced',
        },
      ],
    });

    const handler = new AssessmentGenerationHandler({
      questionGenerationService: questionGenerationService as never,
      questionReviewService: reviewService,
    });

    const result = await handler.handle(
      makeContext({
        assessmentVersionId: 'ver-1',
        blueprintItems: [
          { sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' },
          { sequence: 1, questionType: 'multiple_choice', difficulty: 'medium' },
        ],
      }),
    );

    expect(result.status).toBe('success');
    const reviewed = await reviewStore.listByAssessmentVersion('ws-import-test', 'ver-1');
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]?.blueprintSequence).toBe(0);
  });
});
