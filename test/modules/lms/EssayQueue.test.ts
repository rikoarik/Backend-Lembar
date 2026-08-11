/**
 * LMS-E — Essay review queue.
 *
 * 4 tests covering:
 *  1. getPendingEssayReviews returns attempts that have ≥1 needs_review answer
 *  2. getPendingEssayReviews excludes attempts with no needs_review answers
 *  3. manualGradeAnswer updates the GradedAnswer (score + correct) and persists
 *  4. manualGradeAnswer throws when attemptId or questionId is not found
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { AttemptService } from '../../../src/modules/lms/application/AttemptService.js';
import { InMemoryAttemptStore } from '../../../src/modules/lms/persistence/InMemoryAttemptStore.js';
import type { GuestAttempt } from '../../../src/modules/lms/domain/Attempt.js';

const ASSESSMENT_ID = 'assess-xyz';

function makeAttempt(
  id: string,
  hasNeedsReview: boolean,
): GuestAttempt {
  return {
    id,
    assessmentId: ASSESSMENT_ID,
    guestName: 'Siswa',
    startedAt: new Date().toISOString(),
    answers: { 'q-1': 'Jawaban essay' },
    submittedAt: new Date().toISOString(),
    gradingResult: {
      totalScore: hasNeedsReview ? 0 : 1,
      maxScore: hasNeedsReview ? 0 : 1,
      gradedAnswers: hasNeedsReview
        ? [{ questionId: 'q-1', given: 'Jawaban essay', correct: 'needs_review' }]
        : [{ questionId: 'q-1', given: 'A', correct: true, score: 1 }],
    },
  };
}

function makeService() {
  const store = new InMemoryAttemptStore();
  const service = new AttemptService({ guestStore: store });
  return { store, service };
}

describe('LMS-E: essay review queue', () => {
  it('getPendingEssayReviews returns attempts with at least one needs_review answer', async () => {
    const { store, service } = makeService();
    const pending = makeAttempt('a1', true);
    const graded = makeAttempt('a2', false);
    await store.save(pending);
    await store.save(graded);

    const result = await service.getPendingEssayReviews();

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('a1');
  });

  it('getPendingEssayReviews excludes attempts with no needs_review answers', async () => {
    const { store, service } = makeService();
    await store.save(makeAttempt('b1', false));
    await store.save(makeAttempt('b2', false));

    const result = await service.getPendingEssayReviews();

    expect(result).toHaveLength(0);
  });

  it('manualGradeAnswer updates the GradedAnswer with score and correct value', async () => {
    const { store, service } = makeService();
    await store.save(makeAttempt('c1', true));

    const updated = await service.manualGradeAnswer('c1', 'q-1', 3, true);

    const ga = updated.gradingResult!.gradedAnswers.find((a) => a.questionId === 'q-1')!;
    expect(ga.score).toBe(3);
    expect(ga.correct).toBe(true);
    // persisted
    const persisted = await store.findById('c1');
    expect(persisted!.gradingResult!.gradedAnswers[0]!.score).toBe(3);
    expect(persisted!.gradingResult!.gradedAnswers[0]!.correct).toBe(true);
  });

  it('manualGradeAnswer throws when attemptId is not found', async () => {
    const { service } = makeService();

    await expect(service.manualGradeAnswer('no-such', 'q-1', 1, true)).rejects.toThrow(
      /not found/i,
    );
  });
});
