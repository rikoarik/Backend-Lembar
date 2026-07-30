/**
 * P1-G BE — Contract/persistence tests for open-ended question types.
 *
 * Asserts that 'essay' and 'short_answer' questions:
 *   - can be saved and retrieved via InMemoryQuestionReviewStore
 *   - may carry an empty options array (no MC options required)
 *   - store free-text expected answer (not an option key)
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { InMemoryQuestionReviewStore } from '../../../src/modules/assessments/persistence/InMemoryQuestionReviewStore.js';
import type { ReviewedQuestion } from '../../../src/modules/assessments/domain/QuestionReview.js';

// ---- Fixture ----

function makeReviewedQuestion(overrides: Partial<ReviewedQuestion> = {}): ReviewedQuestion {
  return {
    id: 'rq-1',
    originalQuestionId: 'gq-1',
    assessmentVersionId: 'av-1',
    workspaceId: 'ws-1',
    blueprintSequence: 0,
    questionType: 'essay',
    difficulty: 'medium',
    stem: 'Explain the water cycle.',
    options: [],
    answer: 'Water evaporates, condenses into clouds, and falls as precipitation.',
    explanation: 'Basic earth science cycle.',
    sourceIds: ['src-1'],
    status: 'pending',
    version: 1,
    etag: 'etag-v1',
    candidateId: null,
    isFinalized: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---- Tests ----

describe('P1-G BE: InMemoryQuestionReviewStore — essay question type', () => {
  let store: InMemoryQuestionReviewStore;

  beforeEach(() => {
    store = new InMemoryQuestionReviewStore();
  });

  it('saves and retrieves an essay question by id', async () => {
    const q = makeReviewedQuestion({ questionType: 'essay' });
    await store.save(q);
    const found = await store.findById(q.workspaceId, q.id);
    expect(found).not.toBeNull();
    expect(found!.questionType).toBe('essay');
  });

  it('essay question may have an empty options array', async () => {
    const q = makeReviewedQuestion({ questionType: 'essay', options: [] });
    const saved = await store.save(q);
    expect(saved.options).toEqual([]);

    const found = await store.findById(q.workspaceId, q.id);
    expect(found!.options).toEqual([]);
  });

  it('essay answer field stores free-text expected answer, not an option key', async () => {
    const expectedAnswer = 'Water evaporates, condenses into clouds, and falls as precipitation.';
    const q = makeReviewedQuestion({ questionType: 'essay', options: [], answer: expectedAnswer });
    await store.save(q);

    const found = await store.findById(q.workspaceId, q.id);
    expect(found!.answer).toBe(expectedAnswer);
    // Confirm the answer is not a single option key (A/B/C/D or true/false)
    expect(found!.answer).not.toMatch(/^[ABCD]$/);
    expect(found!.answer).not.toMatch(/^(true|false)$/i);
  });

  it('essay question appears in listByAssessmentVersion', async () => {
    const q = makeReviewedQuestion({ questionType: 'essay' });
    await store.save(q);

    const list = await store.listByAssessmentVersion(q.workspaceId, q.assessmentVersionId);
    expect(list).toHaveLength(1);
    expect(list[0]!.questionType).toBe('essay');
  });

  it('saved essay question is a deep copy — mutations do not affect the store', async () => {
    const q = makeReviewedQuestion({ questionType: 'essay' });
    const saved = await store.save(q);
    saved.stem = 'MUTATED';

    const found = await store.findById(q.workspaceId, q.id);
    expect(found!.stem).toBe('Explain the water cycle.');
  });
});

describe('P1-G BE: InMemoryQuestionReviewStore — short_answer question type', () => {
  let store: InMemoryQuestionReviewStore;

  beforeEach(() => {
    store = new InMemoryQuestionReviewStore();
  });

  it('saves and retrieves a short_answer question by id', async () => {
    const q = makeReviewedQuestion({
      id: 'rq-2',
      originalQuestionId: 'gq-2',
      questionType: 'short_answer',
      stem: 'What is the capital of France?',
      answer: 'Paris',
      options: [],
    });
    await store.save(q);
    const found = await store.findById(q.workspaceId, q.id);
    expect(found).not.toBeNull();
    expect(found!.questionType).toBe('short_answer');
  });

  it('short_answer question may have an empty options array', async () => {
    const q = makeReviewedQuestion({
      id: 'rq-2',
      questionType: 'short_answer',
      options: [],
    });
    const saved = await store.save(q);
    expect(saved.options).toEqual([]);

    const found = await store.findById(q.workspaceId, q.id);
    expect(found!.options).toEqual([]);
  });

  it('short_answer answer field stores free-text expected answer, not an option key', async () => {
    const expectedAnswer = 'Paris';
    const q = makeReviewedQuestion({
      id: 'rq-2',
      questionType: 'short_answer',
      options: [],
      answer: expectedAnswer,
      stem: 'What is the capital of France?',
    });
    await store.save(q);

    const found = await store.findById(q.workspaceId, q.id);
    expect(found!.answer).toBe(expectedAnswer);
    expect(found!.answer).not.toMatch(/^[ABCD]$/);
    expect(found!.answer).not.toMatch(/^(true|false)$/i);
  });

  it('short_answer question appears in listByAssessmentVersion', async () => {
    const q = makeReviewedQuestion({
      id: 'rq-2',
      questionType: 'short_answer',
      options: [],
    });
    await store.save(q);

    const list = await store.listByAssessmentVersion(q.workspaceId, q.assessmentVersionId);
    expect(list).toHaveLength(1);
    expect(list[0]!.questionType).toBe('short_answer');
  });

  it('findByOriginalId returns short_answer question when candidateId is null', async () => {
    const q = makeReviewedQuestion({
      id: 'rq-2',
      originalQuestionId: 'gq-original',
      questionType: 'short_answer',
      options: [],
      candidateId: null,
    });
    await store.save(q);

    const found = await store.findByOriginalId(q.workspaceId, 'gq-original');
    expect(found).not.toBeNull();
    expect(found!.questionType).toBe('short_answer');
  });
});

describe('P1-G BE: InMemoryQuestionReviewStore — mixed question types in same assessment version', () => {
  it('essay and short_answer questions coexist with multiple_choice in listByAssessmentVersion', async () => {
    const store = new InMemoryQuestionReviewStore();

    const mc = makeReviewedQuestion({
      id: 'rq-mc',
      originalQuestionId: 'gq-mc',
      blueprintSequence: 0,
      questionType: 'multiple_choice',
      options: [
        { key: 'A', text: 'Option A' },
        { key: 'B', text: 'Option B' },
      ],
      answer: 'A',
    });
    const sa = makeReviewedQuestion({
      id: 'rq-sa',
      originalQuestionId: 'gq-sa',
      blueprintSequence: 1,
      questionType: 'short_answer',
      options: [],
      answer: 'Paris',
    });
    const essay = makeReviewedQuestion({
      id: 'rq-essay',
      originalQuestionId: 'gq-essay',
      blueprintSequence: 2,
      questionType: 'essay',
      options: [],
      answer: 'The water cycle involves evaporation, condensation, and precipitation.',
    });

    await Promise.all([store.save(mc), store.save(sa), store.save(essay)]);

    const list = await store.listByAssessmentVersion('ws-1', 'av-1');
    expect(list).toHaveLength(3);

    // Sorted by blueprintSequence
    expect(list[0]!.questionType).toBe('multiple_choice');
    expect(list[1]!.questionType).toBe('short_answer');
    expect(list[2]!.questionType).toBe('essay');

    // Open-ended types have empty options
    expect(list[1]!.options).toEqual([]);
    expect(list[2]!.options).toEqual([]);

    // MC answer is an option key; open-ended answers are free text
    expect(list[0]!.answer).toBe('A');
    expect(list[1]!.answer).toBe('Paris');
    expect(list[2]!.answer).toContain('evaporation');
  });
});
