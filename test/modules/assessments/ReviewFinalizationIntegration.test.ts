/**
 * B4-05 — Integration gate: full review + regeneration + conflict + finalization flow.
 *
 * Covers:
 * - Full flow: import → review → regenerate → accept-candidate → finalize
 * - Tenant isolation: workspace A cannot see workspace B questions
 * - Failure cases: edit after finalization rejected, double-finalize idempotent
 * - ETag conflict detection across concurrent edits
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { InMemoryQuestionReviewStore } from '../../../src/modules/assessments/persistence/InMemoryQuestionReviewStore.js';
import {
  QuestionReviewService,
  QuestionNotFoundError,
  QuestionEtagMismatchError,
  QuestionFinalizedError,
  QuestionsPendingError,
} from '../../../src/modules/assessments/application/QuestionReviewService.js';
import { FinalizationService } from '../../../src/modules/assessments/application/FinalizationService.js';
import type { GeneratedQuestion } from '../../../src/modules/assessments/domain/QuestionGeneration.js';

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

describe('B4-05: Integration — full review + regeneration + finalization flow', () => {
  let store: InMemoryQuestionReviewStore;
  let reviewService: QuestionReviewService;
  let finalizationService: FinalizationService;

  const WS = 'ws-integration';
  const AV = 'av-integration';

  beforeEach(() => {
    store = new InMemoryQuestionReviewStore();
    reviewService = new QuestionReviewService({ store });
    finalizationService = new FinalizationService({ store, reviewService });
  });

  it('full happy path: import → edit → regenerate → accept → finalize', async () => {
    // 1. Import
    const gq = makeGQ('gq-1', WS, AV, 0);
    const rq = await reviewService.importQuestion(gq, 'editor-1');
    expect(rq.status).toBe('pending');
    expect(rq.version).toBe(1);

    // 2. Edit with ETag
    const v1Etag = rq.etag;
    const edited = await reviewService.editQuestion(WS, rq.id, { stem: 'Edited stem?', expectedEtag: v1Etag }, 'editor-1');
    expect(edited.version).toBe(2);
    expect(edited.stem).toBe('Edited stem?');

    // 3. Regenerate (create candidate)
    const { original, candidate, created } = await reviewService.createCandidate(WS, rq.id, 'editor-1');
    expect(created).toBe(true);
    expect(original.candidateId).toBe(candidate.id);

    // 4. Accept candidate
    const accepted = await reviewService.acceptCandidate(WS, rq.id, 'editor-1');
    expect(accepted.status).toBe('accepted');
    expect(accepted.candidateId).toBeNull();

    // 5. Finalize
    const result = await finalizationService.finalizeAssessmentVersion(WS, AV, 'editor-1');
    expect(result.alreadyFinalized).toBe(false);
    expect(result.finalization.workspaceId).toBe(WS);

    // 6. Confirm immutable
    await expect(
      reviewService.editQuestion(WS, rq.id, { stem: 'Post-final edit' }, 'editor-1'),
    ).rejects.toThrow(QuestionFinalizedError);
  });

  it('double-finalize is idempotent', async () => {
    const gq = makeGQ('gq-2', WS, AV, 0);
    const rq = await reviewService.importQuestion(gq, 'user-1');
    await reviewService.setStatus(WS, rq.id, 'accepted', 'user-1');

    const r1 = await finalizationService.finalizeAssessmentVersion(WS, AV, 'user-1');
    const r2 = await finalizationService.finalizeAssessmentVersion(WS, AV, 'user-1');

    expect(r1.alreadyFinalized).toBe(false);
    expect(r2.alreadyFinalized).toBe(true);
    expect(r1.finalization.id).toBe(r2.finalization.id);
  });

  it('finalize rejected when questions still pending', async () => {
    const gq = makeGQ('gq-3', WS, AV, 0);
    await reviewService.importQuestion(gq, 'user-1');
    // Not accepting — leave as pending

    await expect(
      finalizationService.finalizeAssessmentVersion(WS, AV, 'user-1'),
    ).rejects.toThrow(QuestionsPendingError);
  });
});

describe('B4-05: Integration — tenant isolation', () => {
  let store: InMemoryQuestionReviewStore;
  let reviewService: QuestionReviewService;

  beforeEach(() => {
    store = new InMemoryQuestionReviewStore();
    reviewService = new QuestionReviewService({ store });
  });

  it('workspace A cannot read workspace B questions', async () => {
    const gqA = makeGQ('gq-ws-a', 'workspace-A', 'av-A', 0);
    const rqA = await reviewService.importQuestion(gqA, 'user-a');

    // Workspace B tries to access workspace A's question
    await expect(
      reviewService.getQuestion('workspace-B', rqA.id),
    ).rejects.toThrow(QuestionNotFoundError);
  });

  it('workspace B cannot edit workspace A questions', async () => {
    const gqA = makeGQ('gq-ws-a2', 'workspace-A', 'av-A', 0);
    const rqA = await reviewService.importQuestion(gqA, 'user-a');

    await expect(
      reviewService.editQuestion('workspace-B', rqA.id, { stem: 'Cross-tenant edit' }, 'user-b'),
    ).rejects.toThrow(QuestionNotFoundError);
  });

  it('workspace B cannot delete workspace A questions', async () => {
    const gqA = makeGQ('gq-ws-a3', 'workspace-A', 'av-A', 0);
    const rqA = await reviewService.importQuestion(gqA, 'user-a');

    await expect(
      reviewService.deleteQuestion('workspace-B', rqA.id, 'user-b'),
    ).rejects.toThrow(QuestionNotFoundError);
  });

  it('each workspace has isolated audit logs', async () => {
    const gqA = makeGQ('gq-a-iso', 'ws-A', 'av-A', 0);
    const gqB = makeGQ('gq-b-iso', 'ws-B', 'av-B', 0);

    const rqA = await reviewService.importQuestion(gqA, 'user-a');
    const rqB = await reviewService.importQuestion(gqB, 'user-b');

    const logA = await reviewService.getAuditLog('ws-A', rqA.id);
    const logB = await reviewService.getAuditLog('ws-B', rqB.id);

    expect(logA).toHaveLength(1);
    expect(logB).toHaveLength(1);
    // Logs are completely separate
    expect(logA[0]!.reviewedQuestionId).toBe(rqA.id);
    expect(logB[0]!.reviewedQuestionId).toBe(rqB.id);
  });
});

describe('B4-05: Integration — ETag concurrent conflict detection', () => {
  let store: InMemoryQuestionReviewStore;
  let reviewService: QuestionReviewService;

  beforeEach(() => {
    store = new InMemoryQuestionReviewStore();
    reviewService = new QuestionReviewService({ store });
  });

  it('two editors: second edit with stale ETag gets 409-class error', async () => {
    const gq = makeGQ('gq-conflict', 'ws-c', 'av-c', 0);
    const rq = await reviewService.importQuestion(gq, 'editor-1');
    const originalEtag = rq.etag;

    // Editor 1 edits first
    await reviewService.editQuestion('ws-c', rq.id, { stem: 'Editor 1 version' }, 'editor-1');

    // Editor 2 submits with the old (stale) ETag
    await expect(
      reviewService.editQuestion(
        'ws-c',
        rq.id,
        { stem: 'Editor 2 version', expectedEtag: originalEtag },
        'editor-2',
      ),
    ).rejects.toThrow(QuestionEtagMismatchError);
  });

  it('editor who wins concurrent race can continue editing', async () => {
    const gq = makeGQ('gq-win', 'ws-w', 'av-w', 0);
    const rq = await reviewService.importQuestion(gq, 'editor-1');

    const v1 = await reviewService.editQuestion('ws-w', rq.id, { stem: 'v1' }, 'editor-1');
    const v2 = await reviewService.editQuestion('ws-w', rq.id, { stem: 'v2', expectedEtag: v1.etag }, 'editor-1');

    expect(v2.version).toBe(3);
    expect(v2.stem).toBe('v2');
  });
});

describe('B4-05: Integration — source integrity across all operations', () => {
  let store: InMemoryQuestionReviewStore;
  let reviewService: QuestionReviewService;

  beforeEach(() => {
    store = new InMemoryQuestionReviewStore();
    reviewService = new QuestionReviewService({ store });
  });

  it('sourceIds preserved through edit → regenerate → accept lifecycle', async () => {
    const gq = makeGQ('gq-src', 'ws-src', 'av-src', 0);
    const originalSources = gq.sourceIds;

    const rq = await reviewService.importQuestion(gq, 'user-1');
    expect(rq.sourceIds).toEqual(originalSources);

    // Edit
    const edited = await reviewService.editQuestion('ws-src', rq.id, { stem: 'New stem' }, 'user-1');
    expect(edited.sourceIds).toEqual(originalSources);

    // Regenerate + accept
    await reviewService.createCandidate('ws-src', rq.id, 'user-1');
    const accepted = await reviewService.acceptCandidate('ws-src', rq.id, 'user-1');
    expect(accepted.sourceIds).toEqual(originalSources);
  });
});
