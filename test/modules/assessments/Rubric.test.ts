/**
 * P1-K — Rubric contract on the question domain.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { InMemoryQuestionReviewStore } from '../../../src/modules/assessments/persistence/InMemoryQuestionReviewStore.js';
import { QuestionReviewService } from '../../../src/modules/assessments/application/QuestionReviewService.js';
import type { GeneratedQuestion } from '../../../src/modules/assessments/domain/QuestionGeneration.js';
import type { RubricCriterion } from '../../../src/modules/assessments/domain/QuestionReview.js';

function makeGQ(overrides: Partial<GeneratedQuestion> = {}): GeneratedQuestion {
  return {
    id: 'gq-rubric-01',
    assessmentVersionId: 'av-rubric-01',
    workspaceId: 'ws-rubric-01',
    blueprintSequence: 0,
    questionType: 'multiple_choice',
    difficulty: 'medium',
    stem: 'What is the capital of France?',
    options: [
      { key: 'A', text: 'Berlin' },
      { key: 'B', text: 'Paris' },
    ],
    answer: 'B',
    explanation: 'Paris is the capital.',
    sourceIds: ['src-1'],
    versionMetadata: {
      blueprintSchemaVersion: '1.0.0',
      providerModelId: 'gpt-4o',
      promptTemplateId: 'default-v1',
      schemaRepairAttempts: 0,
      latencyMs: 100,
    },
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const RUBRIC: RubricCriterion[] = [
  { id: 'rc-1', description: 'Identifies correct capital', maxScore: 5 },
  { id: 'rc-2', description: 'Provides justification', maxScore: 3 },
];

describe('P1-K: Rubric contract', () => {
  let store: InMemoryQuestionReviewStore;
  let service: QuestionReviewService;

  beforeEach(() => {
    store = new InMemoryQuestionReviewStore();
    service = new QuestionReviewService({ store });
  });

  it('sets a rubric on a question', async () => {
    const gq = makeGQ();
    const rq = await service.importQuestion(gq, 'user-1');

    const updated = await service.updateRubric(
      gq.workspaceId,
      gq.assessmentVersionId,
      rq.id,
      RUBRIC,
    );

    expect(updated.rubric).toEqual(RUBRIC);
  });

  it('retrieves the rubric after setting it', async () => {
    const gq = makeGQ();
    const rq = await service.importQuestion(gq, 'user-1');
    await service.updateRubric(gq.workspaceId, gq.assessmentVersionId, rq.id, RUBRIC);

    const fetched = await service.getQuestion(gq.workspaceId, rq.id);

    expect(fetched.rubric).toEqual(RUBRIC);
  });

  it('clears the rubric when set to empty array', async () => {
    const gq = makeGQ();
    const rq = await service.importQuestion(gq, 'user-1');
    await service.updateRubric(gq.workspaceId, gq.assessmentVersionId, rq.id, RUBRIC);

    const cleared = await service.updateRubric(
      gq.workspaceId,
      gq.assessmentVersionId,
      rq.id,
      [],
    );

    expect(cleared.rubric).toEqual([]);
  });
});
