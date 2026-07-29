/**
 * B4-04 — Tests: Immutable finalization.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { InMemoryQuestionReviewStore } from '../../../src/modules/assessments/persistence/InMemoryQuestionReviewStore.js';
import {
  QuestionReviewService,
  QuestionFinalizedError,
  QuestionsPendingError,
} from '../../../src/modules/assessments/application/QuestionReviewService.js';
import { FinalizationService } from '../../../src/modules/assessments/application/FinalizationService.js';
import type { GeneratedQuestion } from '../../../src/modules/assessments/domain/QuestionGeneration.js';
import type { AssessmentFinalization } from '../../../src/modules/assessments/domain/QuestionReview.js';

class FaultInjectingQuestionReviewStore extends InMemoryQuestionReviewStore {
  private failNextSaveFinalization = false;
  private markAllFinalizedCalls = 0;

  injectSaveFinalizationFailureOnce(): void {
    this.failNextSaveFinalization = true;
  }

  getMarkAllFinalizedCalls(): number {
    return this.markAllFinalizedCalls;
  }

  override async markAllFinalized(workspaceId: string, assessmentVersionId: string): Promise<void> {
    this.markAllFinalizedCalls += 1;
    await super.markAllFinalized(workspaceId, assessmentVersionId);
  }

  override async saveFinalization(
    record: AssessmentFinalization,
  ): Promise<AssessmentFinalization> {
    if (this.failNextSaveFinalization) {
      this.failNextSaveFinalization = false;
      await this.unmarkAllFinalized(record.workspaceId, record.assessmentVersionId);
      throw new Error('Injected saveFinalization failure');
    }
    return super.saveFinalization(record);
  }

  private async unmarkAllFinalized(workspaceId: string, assessmentVersionId: string): Promise<void> {
    const rows = await super.listByAssessmentVersion(workspaceId, assessmentVersionId);
    for (const q of rows) {
      await super.save({ ...q, isFinalized: false });
    }
  }
}

function makeAcceptedQuestionStore(
  store: InMemoryQuestionReviewStore,
  reviewService: QuestionReviewService,
) {
  return async (workspaceId = 'ws-001', assessmentVersionId = 'av-001', actorUserId = 'user-1') => {
    const gq = {
      ...makeGQ(`gq-${workspaceId}-${assessmentVersionId}`),
      workspaceId,
      assessmentVersionId,
    } satisfies GeneratedQuestion;
    const rq = await reviewService.importQuestion(gq, actorUserId);
    await reviewService.setStatus(workspaceId, rq.id, 'accepted', actorUserId);
    return { store, rq };
  };
}

function makeGQ(id = 'gq-001', seq = 0): GeneratedQuestion {
  return {
    id,
    assessmentVersionId: 'av-001',
    workspaceId: 'ws-001',
    blueprintSequence: seq,
    questionType: 'multiple_choice',
    difficulty: 'easy',
    stem: `Question ${seq}?`,
    options: [{ key: 'A', text: 'Yes' }, { key: 'B', text: 'No' }],
    answer: 'A',
    explanation: 'Because.',
    sourceIds: ['src-1'],
    versionMetadata: {
      blueprintSchemaVersion: '1.0.0',
      providerModelId: 'gpt-4o',
      promptTemplateId: 'v1',
      schemaRepairAttempts: 0,
      latencyMs: 100,
    },
    createdAt: '2024-01-01T00:00:00.000Z',
  };
}

describe('B4-04: FinalizationService', () => {
  let store: InMemoryQuestionReviewStore;
  let reviewService: QuestionReviewService;
  let finalizationService: FinalizationService;

  beforeEach(() => {
    store = new InMemoryQuestionReviewStore();
    reviewService = new QuestionReviewService({ store });
    finalizationService = new FinalizationService({ store, reviewService });
  });

  it('rejects an empty assessment version before finalization writes', async () => {
    const markAllFinalized = vi.spyOn(reviewService, 'markAllFinalized');
    const saveFinalization = vi.spyOn(store, 'saveFinalization');

    await expect(
      finalizationService.finalizeAssessmentVersion('ws-001', 'av-001', 'user-1'),
    ).rejects.toThrow(QuestionsPendingError);
    expect(markAllFinalized).not.toHaveBeenCalled();
    expect(saveFinalization).not.toHaveBeenCalled();
  });

  it('throws QuestionsPendingError if not all questions are accepted', async () => {
    const gq = makeGQ();
    await reviewService.importQuestion(gq, 'user-1'); // pending status

    await expect(
      finalizationService.finalizeAssessmentVersion('ws-001', 'av-001', 'user-1'),
    ).rejects.toThrow(QuestionsPendingError);
  });

  it('finalizes successfully when all questions accepted', async () => {
    const gq = makeGQ();
    const rq = await reviewService.importQuestion(gq, 'user-1');
    await reviewService.setStatus('ws-001', rq.id, 'accepted', 'user-1');

    const result = await finalizationService.finalizeAssessmentVersion('ws-001', 'av-001', 'user-1');

    expect(result.alreadyFinalized).toBe(false);
    expect(result.finalization.assessmentVersionId).toBe('av-001');
    expect(result.finalization.finalizedBy).toBe('user-1');
  });

  it('finalization is idempotent — second call returns alreadyFinalized=true', async () => {
    const gq = makeGQ();
    const rq = await reviewService.importQuestion(gq, 'user-1');
    await reviewService.setStatus('ws-001', rq.id, 'accepted', 'user-1');

    const r1 = await finalizationService.finalizeAssessmentVersion('ws-001', 'av-001', 'user-1');
    const r2 = await finalizationService.finalizeAssessmentVersion('ws-001', 'av-001', 'user-1');

    expect(r2.alreadyFinalized).toBe(true);
    expect(r2.finalization.id).toBe(r1.finalization.id);
  });

  it('retries idempotently after saveFinalization fails after markAllFinalized', async () => {
    const faultStore = new FaultInjectingQuestionReviewStore();
    const faultReviewService = new QuestionReviewService({ store: faultStore });
    const faultFinalizationService = new FinalizationService({
      store: faultStore,
      reviewService: faultReviewService,
    });
    const seedAcceptedQuestion = makeAcceptedQuestionStore(faultStore, faultReviewService);
    const { rq } = await seedAcceptedQuestion();

    faultStore.injectSaveFinalizationFailureOnce();

    await expect(
      faultFinalizationService.finalizeAssessmentVersion('ws-001', 'av-001', 'user-1'),
    ).rejects.toThrow('Injected saveFinalization failure');

    const afterFailure = await faultReviewService.getQuestion('ws-001', rq.id);
    expect(afterFailure.isFinalized).toBe(false);
    expect(await faultFinalizationService.getFinalization('ws-001', 'av-001')).toBeNull();

    const retry = await faultFinalizationService.finalizeAssessmentVersion('ws-001', 'av-001', 'user-1');
    expect(retry.alreadyFinalized).toBe(false);
    expect(faultStore.getMarkAllFinalizedCalls()).toBe(2);

    const afterRetry = await faultReviewService.getQuestion('ws-001', rq.id);
    expect(afterRetry.isFinalized).toBe(true);
    expect(await faultFinalizationService.isFinalized('ws-001', 'av-001')).toBe(true);
  });

  it('marks all questions as finalized after finalization', async () => {
    const gq = makeGQ();
    const rq = await reviewService.importQuestion(gq, 'user-1');
    await reviewService.setStatus('ws-001', rq.id, 'accepted', 'user-1');

    await finalizationService.finalizeAssessmentVersion('ws-001', 'av-001', 'user-1');

    const q = await reviewService.getQuestion('ws-001', rq.id);
    expect(q.isFinalized).toBe(true);
  });

  it('blocks edits after finalization with QuestionFinalizedError', async () => {
    const gq = makeGQ();
    const rq = await reviewService.importQuestion(gq, 'user-1');
    await reviewService.setStatus('ws-001', rq.id, 'accepted', 'user-1');
    await finalizationService.finalizeAssessmentVersion('ws-001', 'av-001', 'user-1');

    await expect(
      reviewService.editQuestion('ws-001', rq.id, { stem: 'New stem' }, 'user-1'),
    ).rejects.toThrow(QuestionFinalizedError);
  });

  it('rejects if any question is rejected (not accepted)', async () => {
    const gq1 = makeGQ('gq-001', 0);
    const gq2 = makeGQ('gq-002', 1);
    const rq1 = await reviewService.importQuestion(gq1, 'user-1');
    const rq2 = await reviewService.importQuestion(gq2, 'user-1');

    await reviewService.setStatus('ws-001', rq1.id, 'accepted', 'user-1');
    await reviewService.setStatus('ws-001', rq2.id, 'rejected', 'user-1');

    await expect(
      finalizationService.finalizeAssessmentVersion('ws-001', 'av-001', 'user-1'),
    ).rejects.toThrow(QuestionsPendingError);
  });

  it('isFinalized returns correct value', async () => {
    const gq = makeGQ();
    const rq = await reviewService.importQuestion(gq, 'user-1');

    expect(await finalizationService.isFinalized('ws-001', 'av-001')).toBe(false);

    await reviewService.setStatus('ws-001', rq.id, 'accepted', 'user-1');
    await finalizationService.finalizeAssessmentVersion('ws-001', 'av-001', 'user-1');

    expect(await finalizationService.isFinalized('ws-001', 'av-001')).toBe(true);
  });
});
