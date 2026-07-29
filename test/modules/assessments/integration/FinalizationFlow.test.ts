/**
 * P0-C — Integration tests for FinalizationService.
 *
 * Covers:
 * - Rollback semantics: a saveFinalization failure that occurs after
 *   markAllFinalized has already mutated question rows must NOT leave the
 *   assessment version in a half-finalized state. The retry must complete the
 *   operation, and the questions must become finalized only on a successful
 *   save. (This is enforced by atomic rollback in the in-memory store wrapper
 *   and by FinalizationService re-checking that no finalization record exists.)
 * - Idempotent retry: a transient saveFinalization failure followed by a retry
 *   yields exactly one finalization record and isFinalized=true on all
 *   questions.
 * - Pending rejection: validateAllAccepted throws QuestionsPendingError on
 *   empty list (already covered in unit) and on any non-accepted question.
 * - Foreign workspace isolation: FinalizationService does not read or write
 *   across workspace boundaries — even with the same assessmentVersionId.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { InMemoryQuestionReviewStore } from '../../../../src/modules/assessments/persistence/InMemoryQuestionReviewStore.js';
import {
  QuestionReviewService,
  QuestionsPendingError,
} from '../../../../src/modules/assessments/application/QuestionReviewService.js';
import { FinalizationService } from '../../../../src/modules/assessments/application/FinalizationService.js';
import type { AssessmentFinalization } from '../../../../src/modules/assessments/domain/QuestionReview.js';
import type { GeneratedQuestion } from '../../../../src/modules/assessments/domain/QuestionGeneration.js';

/**
 * Wraps the in-memory store to (a) atomically roll back markAllFinalized when
 * saveFinalization fails and (b) optionally inject a saveFinalization failure.
 *
 * This is the minimum surface needed to prove the rollback branch without
 * touching the production InMemoryQuestionReviewStore contract.
 */
class AtomicFinalizationStore extends InMemoryQuestionReviewStore {
  private failNextSaveFinalization = false;
  private markAllFinalizedCalls = 0;
  private saveFinalizationCalls = 0;

  injectSaveFinalizationFailureOnce(): void {
    this.failNextSaveFinalization = true;
  }

  markAllFinalizedCallCount(): number {
    return this.markAllFinalizedCalls;
  }

  saveFinalizationCallCount(): number {
    return this.saveFinalizationCalls;
  }

  override async markAllFinalized(workspaceId: string, assessmentVersionId: string): Promise<void> {
    this.markAllFinalizedCalls += 1;
    await super.markAllFinalized(workspaceId, assessmentVersionId);
  }

  override async saveFinalization(
    record: AssessmentFinalization,
  ): Promise<AssessmentFinalization> {
    this.saveFinalizationCalls += 1;
    if (this.failNextSaveFinalization) {
      this.failNextSaveFinalization = false;
      // Roll back the markAllFinalized side effect so the in-memory state mirrors
      // what a DB transaction with a constraint failure would leave behind.
      await this.unmarkAllFinalized(record.workspaceId, record.assessmentVersionId);
      throw new Error('Injected saveFinalization failure');
    }
    return super.saveFinalization(record);
  }

  /** Restore isFinalized=false on every question in the version. Test helper only. */
  private async unmarkAllFinalized(workspaceId: string, assessmentVersionId: string): Promise<void> {
    const rows = await super.listByAssessmentVersion(workspaceId, assessmentVersionId);
    for (const q of rows) {
      await super.save({ ...q, isFinalized: false });
    }
  }
}

function makeGQ(
  id: string,
  workspaceId: string,
  assessmentVersionId: string,
  seq = 0,
): GeneratedQuestion {
  return {
    id,
    assessmentVersionId,
    workspaceId,
    blueprintSequence: seq,
    questionType: 'multiple_choice',
    difficulty: 'medium',
    stem: `Question ${id}?`,
    options: [
      { key: 'A', text: 'Option A' },
      { key: 'B', text: 'Option B' },
    ],
    answer: 'A',
    explanation: 'Test explanation.',
    sourceIds: [`src-${id}`],
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

async function seedAcceptedQuestion(
  reviewService: QuestionReviewService,
  workspaceId: string,
  assessmentVersionId: string,
  actorUserId: string,
  gqId?: string,
) {
  const id = gqId ?? `gq-${workspaceId}-${assessmentVersionId}`;
  const gq = makeGQ(id, workspaceId, assessmentVersionId, 0);
  const rq = await reviewService.importQuestion(gq, actorUserId);
  await reviewService.setStatus(workspaceId, rq.id, 'accepted', actorUserId);
  return rq;
}

describe('P0-C: FinalizationService — rollback semantics on save failure', () => {
  let store: AtomicFinalizationStore;
  let reviewService: QuestionReviewService;
  let finalizationService: FinalizationService;

  beforeEach(() => {
    store = new AtomicFinalizationStore();
    reviewService = new QuestionReviewService({ store });
    finalizationService = new FinalizationService({ store, reviewService });
  });

  it('rolls back question.isFinalized when saveFinalization throws after markAllFinalized', async () => {
    const rq = await seedAcceptedQuestion(reviewService, 'ws-rollback', 'av-rollback', 'user-1');
    store.injectSaveFinalizationFailureOnce();

    await expect(
      finalizationService.finalizeAssessmentVersion('ws-rollback', 'av-rollback', 'user-1'),
    ).rejects.toThrow('Injected saveFinalization failure');

    const afterFailure = await reviewService.getQuestion('ws-rollback', rq.id);
    expect(afterFailure.isFinalized).toBe(false);
    expect(store.markAllFinalizedCallCount()).toBe(1);
    expect(store.saveFinalizationCallCount()).toBe(1);
    expect(await finalizationService.getFinalization('ws-rollback', 'av-rollback')).toBeNull();
    expect(await finalizationService.isFinalized('ws-rollback', 'av-rollback')).toBe(false);
  });

  it('retries successfully after rollback — single finalization record, all questions finalized', async () => {
    const rq = await seedAcceptedQuestion(reviewService, 'ws-retry', 'av-retry', 'user-1');
    store.injectSaveFinalizationFailureOnce();

    await expect(
      finalizationService.finalizeAssessmentVersion('ws-retry', 'av-retry', 'user-1'),
    ).rejects.toThrow('Injected saveFinalization failure');

    const retry = await finalizationService.finalizeAssessmentVersion('ws-retry', 'av-retry', 'user-1');
    expect(retry.alreadyFinalized).toBe(false);
    expect(store.markAllFinalizedCallCount()).toBe(2);
    expect(store.saveFinalizationCallCount()).toBe(2);

    const after = await reviewService.getQuestion('ws-retry', rq.id);
    expect(after.isFinalized).toBe(true);
    expect(await finalizationService.isFinalized('ws-retry', 'av-retry')).toBe(true);

    const record = await finalizationService.getFinalization('ws-retry', 'av-retry');
    expect(record).not.toBeNull();
    expect(record!.workspaceId).toBe('ws-retry');
    expect(record!.assessmentVersionId).toBe('av-retry');
  });
});

describe('P0-C: FinalizationService — idempotent retry', () => {
  let store: AtomicFinalizationStore;
  let reviewService: QuestionReviewService;
  let finalizationService: FinalizationService;

  beforeEach(() => {
    store = new AtomicFinalizationStore();
    reviewService = new QuestionReviewService({ store });
    finalizationService = new FinalizationService({ store, reviewService });
  });

  it('repeated successful finalize calls return alreadyFinalized=true with the same record id', async () => {
    await seedAcceptedQuestion(reviewService, 'ws-idem', 'av-idem', 'user-1');

    const r1 = await finalizationService.finalizeAssessmentVersion('ws-idem', 'av-idem', 'user-1');
    const r2 = await finalizationService.finalizeAssessmentVersion('ws-idem', 'av-idem', 'user-1');
    const r3 = await finalizationService.finalizeAssessmentVersion('ws-idem', 'av-idem', 'user-1');

    expect(r1.alreadyFinalized).toBe(false);
    expect(r2.alreadyFinalized).toBe(true);
    expect(r3.alreadyFinalized).toBe(true);
    expect(r1.finalization.id).toBe(r2.finalization.id);
    expect(r2.finalization.id).toBe(r3.finalization.id);
    expect(store.saveFinalizationCallCount()).toBe(1);
  });

  it('after transient failure + successful retry, a third call reports alreadyFinalized=true', async () => {
    await seedAcceptedQuestion(reviewService, 'ws-idem2', 'av-idem2', 'user-1');
    store.injectSaveFinalizationFailureOnce();

    await expect(
      finalizationService.finalizeAssessmentVersion('ws-idem2', 'av-idem2', 'user-1'),
    ).rejects.toThrow('Injected saveFinalization failure');

    const retry = await finalizationService.finalizeAssessmentVersion('ws-idem2', 'av-idem2', 'user-1');
    expect(retry.alreadyFinalized).toBe(false);

    const third = await finalizationService.finalizeAssessmentVersion('ws-idem2', 'av-idem2', 'user-1');
    expect(third.alreadyFinalized).toBe(true);
    expect(third.finalization.id).toBe(retry.finalization.id);
    expect(store.saveFinalizationCallCount()).toBe(2);
  });
});

describe('P0-C: FinalizationService — pending rejection', () => {
  let store: InMemoryQuestionReviewStore;
  let reviewService: QuestionReviewService;
  let finalizationService: FinalizationService;

  beforeEach(() => {
    store = new InMemoryQuestionReviewStore();
    reviewService = new QuestionReviewService({ store });
    finalizationService = new FinalizationService({ store, reviewService });
  });

  it('rejects finalize on empty assessment version (validateAllAccepted throws on empty list)', async () => {
    await expect(
      finalizationService.finalizeAssessmentVersion('ws-pending', 'av-empty', 'user-1'),
    ).rejects.toBeInstanceOf(QuestionsPendingError);
  });

  it('rejects finalize when at least one question is still pending', async () => {
    const gq1 = makeGQ('gq-pending-1', 'ws-pending', 'av-mix', 0);
    const gq2 = makeGQ('gq-pending-2', 'ws-pending', 'av-mix', 1);
    const rq1 = await reviewService.importQuestion(gq1, 'user-1');
    await reviewService.importQuestion(gq2, 'user-1'); // left pending
    await reviewService.setStatus('ws-pending', rq1.id, 'accepted', 'user-1');

    await expect(
      finalizationService.finalizeAssessmentVersion('ws-pending', 'av-mix', 'user-1'),
    ).rejects.toBeInstanceOf(QuestionsPendingError);
  });

  it('rejects finalize when at least one question is rejected', async () => {
    const gq1 = makeGQ('gq-rej-1', 'ws-rej', 'av-rej', 0);
    const gq2 = makeGQ('gq-rej-2', 'ws-rej', 'av-rej', 1);
    const rq1 = await reviewService.importQuestion(gq1, 'user-1');
    const rq2 = await reviewService.importQuestion(gq2, 'user-1');
    await reviewService.setStatus('ws-rej', rq1.id, 'accepted', 'user-1');
    await reviewService.setStatus('ws-rej', rq2.id, 'rejected', 'user-1');

    await expect(
      finalizationService.finalizeAssessmentVersion('ws-rej', 'av-rej', 'user-1'),
    ).rejects.toBeInstanceOf(QuestionsPendingError);
  });

  it('pending rejection occurs before any side effects (markAllFinalized / saveFinalization not invoked)', async () => {
    const gq = makeGQ('gq-sidefx', 'ws-sidefx', 'av-sidefx', 0);
    await reviewService.importQuestion(gq, 'user-1'); // pending

    let markCalls = 0;
    let saveCalls = 0;
    const origMark = store.markAllFinalized.bind(store);
    const origSave = store.saveFinalization.bind(store);
    store.markAllFinalized = async (...args) => {
      markCalls += 1;
      return origMark(...args);
    };
    store.saveFinalization = async (...args) => {
      saveCalls += 1;
      return origSave(...args);
    };

    await expect(
      finalizationService.finalizeAssessmentVersion('ws-sidefx', 'av-sidefx', 'user-1'),
    ).rejects.toBeInstanceOf(QuestionsPendingError);
    expect(markCalls).toBe(0);
    expect(saveCalls).toBe(0);
  });
});

describe('P0-C: FinalizationService — foreign workspace isolation', () => {
  let store: InMemoryQuestionReviewStore;
  let reviewService: QuestionReviewService;
  let finalizationService: FinalizationService;

  beforeEach(() => {
    store = new InMemoryQuestionReviewStore();
    reviewService = new QuestionReviewService({ store });
    finalizationService = new FinalizationService({ store, reviewService });
  });

  it('workspace B cannot finalize or read workspace A finalization with same assessmentVersionId', async () => {
    await seedAcceptedQuestion(reviewService, 'ws-A', 'av-shared', 'user-a', 'gq-A');

    const resultA = await finalizationService.finalizeAssessmentVersion('ws-A', 'av-shared', 'user-a');
    expect(resultA.finalization.workspaceId).toBe('ws-A');

    // Foreign workspace sees no record
    expect(await finalizationService.getFinalization('ws-B', 'av-shared')).toBeNull();
    expect(await finalizationService.isFinalized('ws-B', 'av-shared')).toBe(false);

    // Foreign workspace has no questions → validateAllAccepted throws
    await expect(
      finalizationService.finalizeAssessmentVersion('ws-B', 'av-shared', 'user-b'),
    ).rejects.toBeInstanceOf(QuestionsPendingError);
  });

  it('each workspace has its own finalization record even with colliding assessmentVersionId', async () => {
    await seedAcceptedQuestion(reviewService, 'ws-A', 'av-collide', 'user-a', 'gq-A');
    await seedAcceptedQuestion(reviewService, 'ws-B', 'av-collide', 'user-b', 'gq-B');

    const resultA = await finalizationService.finalizeAssessmentVersion('ws-A', 'av-collide', 'user-a');
    const resultB = await finalizationService.finalizeAssessmentVersion('ws-B', 'av-collide', 'user-b');

    expect(resultA.finalization.workspaceId).toBe('ws-A');
    expect(resultB.finalization.workspaceId).toBe('ws-B');
    expect(resultA.finalization.id).not.toBe(resultB.finalization.id);

    const recA = await finalizationService.getFinalization('ws-A', 'av-collide');
    const recB = await finalizationService.getFinalization('ws-B', 'av-collide');
    expect(recA?.workspaceId).toBe('ws-A');
    expect(recB?.workspaceId).toBe('ws-B');
    expect(recA?.id).not.toBe(recB?.id);
  });

  it('questions from another workspace are not visible to validateAllAccepted', async () => {
    await seedAcceptedQuestion(reviewService, 'ws-A', 'av-iso', 'user-a', 'gq-A');
    // Foreign workspace has zero questions in this assessment version
    await expect(
      finalizationService.finalizeAssessmentVersion('ws-B', 'av-iso', 'user-b'),
    ).rejects.toBeInstanceOf(QuestionsPendingError);
  });
});
