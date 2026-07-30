/**
 * LMS-D — Auto-grading on submit.
 *
 * 9 tests covering:
 *  1. MC correct answer → correct: true, score: 1
 *  2. MC wrong answer → correct: false, score: 0
 *  3. true_false correct → correct: true, score: 1
 *  4. true_false wrong → correct: false, score: 0
 *  5. essay → correct: 'needs_review', no score
 *  6. short_answer → correct: 'needs_review', no score
 *  7. total score = sum of auto-graded scores (needs_review excluded)
 *  8. grading result stored on the attempt after submitAttempt
 *  9. no questions param → no gradingResult on attempt (backward compat)
 */
import { describe, it, expect } from 'vitest';

import { AttemptService } from '../../../src/modules/lms/application/AttemptService.js';
import { InMemoryAttemptStore } from '../../../src/modules/lms/persistence/InMemoryAttemptStore.js';
import type { GradingQuestion } from '../../../src/modules/lms/domain/Attempt.js';

const ASSESSMENT_ID = 'assess-grading-001';

function makeService() {
  const store = new InMemoryAttemptStore();
  const service = new AttemptService(store);
  return { store, service };
}

const questions: GradingQuestion[] = [
  { questionId: 'q-mc-1', type: 'multiple_choice', answerKey: 'A' },
  { questionId: 'q-mc-2', type: 'multiple_choice', answerKey: 'C' },
  { questionId: 'q-tf-1', type: 'true_false', answerKey: 'true' },
  { questionId: 'q-tf-2', type: 'true_false', answerKey: 'false' },
  { questionId: 'q-essay-1', type: 'essay' },
  { questionId: 'q-short-1', type: 'short_answer' },
];

describe('AutoGrading', () => {
  it('grades MC correct answer as correct: true with score 1', async () => {
    const { service } = makeService();
    const attempt = await service.startGuestAttempt(ASSESSMENT_ID, 'Tester');
    const submitted = await service.submitAttempt(
      attempt.id,
      { 'q-mc-1': 'A' },
      [{ questionId: 'q-mc-1', type: 'multiple_choice', answerKey: 'A' }],
    );

    const result = submitted.gradingResult!;
    const grade = result.gradedAnswers.find((g) => g.questionId === 'q-mc-1')!;
    expect(grade.correct).toBe(true);
    expect(grade.score).toBe(1);
  });

  it('grades MC wrong answer as correct: false with score 0', async () => {
    const { service } = makeService();
    const attempt = await service.startGuestAttempt(ASSESSMENT_ID, 'Tester');
    const submitted = await service.submitAttempt(
      attempt.id,
      { 'q-mc-1': 'B' },
      [{ questionId: 'q-mc-1', type: 'multiple_choice', answerKey: 'A' }],
    );

    const grade = submitted.gradingResult!.gradedAnswers.find((g) => g.questionId === 'q-mc-1')!;
    expect(grade.correct).toBe(false);
    expect(grade.score).toBe(0);
  });

  it('grades true_false correct answer as correct: true with score 1', async () => {
    const { service } = makeService();
    const attempt = await service.startGuestAttempt(ASSESSMENT_ID, 'Tester');
    const submitted = await service.submitAttempt(
      attempt.id,
      { 'q-tf-1': 'true' },
      [{ questionId: 'q-tf-1', type: 'true_false', answerKey: 'true' }],
    );

    const grade = submitted.gradingResult!.gradedAnswers.find((g) => g.questionId === 'q-tf-1')!;
    expect(grade.correct).toBe(true);
    expect(grade.score).toBe(1);
  });

  it('grades true_false wrong answer as correct: false with score 0', async () => {
    const { service } = makeService();
    const attempt = await service.startGuestAttempt(ASSESSMENT_ID, 'Tester');
    const submitted = await service.submitAttempt(
      attempt.id,
      { 'q-tf-2': 'true' },
      [{ questionId: 'q-tf-2', type: 'true_false', answerKey: 'false' }],
    );

    const grade = submitted.gradingResult!.gradedAnswers.find((g) => g.questionId === 'q-tf-2')!;
    expect(grade.correct).toBe(false);
    expect(grade.score).toBe(0);
  });

  it('marks essay as needs_review with no score', async () => {
    const { service } = makeService();
    const attempt = await service.startGuestAttempt(ASSESSMENT_ID, 'Tester');
    const submitted = await service.submitAttempt(
      attempt.id,
      { 'q-essay-1': 'Jawaban panjang ini...' },
      [{ questionId: 'q-essay-1', type: 'essay' }],
    );

    const grade = submitted.gradingResult!.gradedAnswers.find(
      (g) => g.questionId === 'q-essay-1',
    )!;
    expect(grade.correct).toBe('needs_review');
    expect(grade.score).toBeUndefined();
  });

  it('marks short_answer as needs_review with no score', async () => {
    const { service } = makeService();
    const attempt = await service.startGuestAttempt(ASSESSMENT_ID, 'Tester');
    const submitted = await service.submitAttempt(
      attempt.id,
      { 'q-short-1': 'jawaban singkat' },
      [{ questionId: 'q-short-1', type: 'short_answer' }],
    );

    const grade = submitted.gradingResult!.gradedAnswers.find(
      (g) => g.questionId === 'q-short-1',
    )!;
    expect(grade.correct).toBe('needs_review');
    expect(grade.score).toBeUndefined();
  });

  it('calculates totalScore as sum of auto-graded scores only', async () => {
    const { service } = makeService();
    const attempt = await service.startGuestAttempt(ASSESSMENT_ID, 'Tester');
    // q-mc-1: correct(1), q-mc-2: wrong(0), q-tf-1: correct(1), q-essay-1: needs_review
    const submitted = await service.submitAttempt(
      attempt.id,
      { 'q-mc-1': 'A', 'q-mc-2': 'B', 'q-tf-1': 'true', 'q-essay-1': 'some essay' },
      questions,
    );

    // Only auto-graded contribute: 1 + 0 + 1 = 2; needs_review questions not counted
    expect(submitted.gradingResult!.totalScore).toBe(2);
  });

  it('stores gradingResult on the attempt after submit', async () => {
    const { service, store } = makeService();
    const attempt = await service.startGuestAttempt(ASSESSMENT_ID, 'Tester');
    await service.submitAttempt(
      attempt.id,
      { 'q-mc-1': 'A' },
      [{ questionId: 'q-mc-1', type: 'multiple_choice', answerKey: 'A' }],
    );

    const stored = await store.findById(attempt.id);
    expect(stored!.gradingResult).toBeDefined();
    expect(stored!.gradingResult!.gradedAnswers).toHaveLength(1);
  });

  it('does not set gradingResult when no questions provided (backward compat)', async () => {
    const { service } = makeService();
    const attempt = await service.startGuestAttempt(ASSESSMENT_ID, 'Tester');
    const submitted = await service.submitAttempt(attempt.id, { 'q-1': 'A' });

    expect(submitted.gradingResult).toBeUndefined();
  });
});
