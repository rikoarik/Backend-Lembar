/**
 * B4-01 — Tests: Question review, edit, and audit.
 * B4-03 — Tests: ETag / optimistic concurrency.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { InMemoryQuestionReviewStore } from '../../../src/modules/assessments/persistence/InMemoryQuestionReviewStore.js';
import {
  QuestionReviewService,
  QuestionNotFoundError,
  QuestionEtagMismatchError,
  QuestionFinalizedError,
} from '../../../src/modules/assessments/application/QuestionReviewService.js';
import type { GeneratedQuestion } from '../../../src/modules/assessments/domain/QuestionGeneration.js';

// ---- Test helpers ----

function makeGeneratedQuestion(overrides: Partial<GeneratedQuestion> = {}): GeneratedQuestion {
  return {
    id: 'gq-001',
    assessmentVersionId: 'av-001',
    workspaceId: 'ws-001',
    blueprintSequence: 0,
    questionType: 'multiple_choice',
    difficulty: 'medium',
    stem: 'What is 2+2?',
    options: [
      { key: 'A', text: '3' },
      { key: 'B', text: '4' },
      { key: 'C', text: '5' },
    ],
    answer: 'B',
    explanation: 'Basic arithmetic.',
    sourceIds: ['src-1', 'src-2'],
    versionMetadata: {
      blueprintSchemaVersion: '1.0.0',
      providerModelId: 'gpt-4o',
      promptTemplateId: 'default-v1',
      schemaRepairAttempts: 0,
      latencyMs: 500,
    },
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---- Tests ----

describe('B4-01: QuestionReviewService — importQuestion', () => {
  let store: InMemoryQuestionReviewStore;
  let service: QuestionReviewService;

  beforeEach(() => {
    store = new InMemoryQuestionReviewStore();
    service = new QuestionReviewService({ store });
  });

  it('imports a generated question and creates reviewed question', async () => {
    const gq = makeGeneratedQuestion();
    const rq = await service.importQuestion(gq, 'user-1');

    expect(rq.originalQuestionId).toBe(gq.id);
    expect(rq.workspaceId).toBe(gq.workspaceId);
    expect(rq.assessmentVersionId).toBe(gq.assessmentVersionId);
    expect(rq.stem).toBe(gq.stem);
    expect(rq.status).toBe('pending');
    expect(rq.version).toBe(1);
    expect(rq.etag).toBeTruthy();
    expect(rq.sourceIds).toEqual(gq.sourceIds);
    expect(rq.candidateId).toBeNull();
    expect(rq.isFinalized).toBe(false);
  });

  it('importQuestion is idempotent — returns same record on second call', async () => {
    const gq = makeGeneratedQuestion();
    const rq1 = await service.importQuestion(gq, 'user-1');
    const rq2 = await service.importQuestion(gq, 'user-1');
    expect(rq1.id).toBe(rq2.id);
    expect(rq1.version).toBe(rq2.version);
  });

  it('creates an audit entry with action=created', async () => {
    const gq = makeGeneratedQuestion();
    const rq = await service.importQuestion(gq, 'user-1');
    const log = await service.getAuditLog(gq.workspaceId, rq.id);
    expect(log).toHaveLength(1);
    expect(log[0]!.action).toBe('created');
    expect(log[0]!.actorUserId).toBe('user-1');
    expect(log[0]!.previousSnapshot).toBeNull();
    expect(log[0]!.nextSnapshot?.id).toBe(rq.id);
  });
});

describe('B4-01: QuestionReviewService — editQuestion', () => {
  let store: InMemoryQuestionReviewStore;
  let service: QuestionReviewService;

  beforeEach(() => {
    store = new InMemoryQuestionReviewStore();
    service = new QuestionReviewService({ store });
  });

  it('edits a question and increments version + etag', async () => {
    const gq = makeGeneratedQuestion();
    const rq = await service.importQuestion(gq, 'user-1');
    const v1Etag = rq.etag;

    const edited = await service.editQuestion(
      gq.workspaceId,
      rq.id,
      { stem: 'Updated stem?' },
      'user-1',
    );

    expect(edited.stem).toBe('Updated stem?');
    expect(edited.version).toBe(2);
    expect(edited.etag).not.toBe(v1Etag);
  });

  it('source integrity: sourceIds not modified by edit', async () => {
    const gq = makeGeneratedQuestion();
    const rq = await service.importQuestion(gq, 'user-1');
    const edited = await service.editQuestion(
      gq.workspaceId,
      rq.id,
      { stem: 'New stem' },
      'user-1',
    );
    expect(edited.sourceIds).toEqual(gq.sourceIds);
  });

  it('appends edited audit entry', async () => {
    const gq = makeGeneratedQuestion();
    const rq = await service.importQuestion(gq, 'user-1');
    await service.editQuestion(gq.workspaceId, rq.id, { stem: 'New?' }, 'user-2');
    const log = await service.getAuditLog(gq.workspaceId, rq.id);
    expect(log).toHaveLength(2);
    expect(log[1]!.action).toBe('edited');
    expect(log[1]!.actorUserId).toBe('user-2');
    expect(log[1]!.previousSnapshot?.stem).toBe('What is 2+2?');
    expect(log[1]!.nextSnapshot?.stem).toBe('New?');
  });

  it('throws QuestionNotFoundError for unknown id', async () => {
    await expect(
      service.editQuestion('ws-001', 'non-existent', { stem: 'X' }, 'user-1'),
    ).rejects.toThrow(QuestionNotFoundError);
  });
});

describe('B4-01: QuestionReviewService — deleteQuestion', () => {
  let store: InMemoryQuestionReviewStore;
  let service: QuestionReviewService;

  beforeEach(() => {
    store = new InMemoryQuestionReviewStore();
    service = new QuestionReviewService({ store });
  });

  it('deletes question and appends deleted audit entry', async () => {
    const gq = makeGeneratedQuestion();
    const rq = await service.importQuestion(gq, 'user-1');
    await service.deleteQuestion(gq.workspaceId, rq.id, 'user-1');

    // Verify hard delete
    await expect(service.getQuestion(gq.workspaceId, rq.id)).rejects.toThrow(QuestionNotFoundError);

    // Audit log still accessible
    const log = await service.getAuditLog(gq.workspaceId, rq.id);
    const deletedEntry = log.find((e) => e.action === 'deleted');
    expect(deletedEntry).toBeDefined();
  });

  it('throws QuestionNotFoundError when deleting non-existent question', async () => {
    await expect(
      service.deleteQuestion('ws-001', 'ghost', 'user-1'),
    ).rejects.toThrow(QuestionNotFoundError);
  });
});

describe('B4-03: QuestionReviewService — ETag optimistic concurrency', () => {
  let store: InMemoryQuestionReviewStore;
  let service: QuestionReviewService;

  beforeEach(() => {
    store = new InMemoryQuestionReviewStore();
    service = new QuestionReviewService({ store });
  });

  it('ETag round-trip: edit with correct ETag succeeds', async () => {
    const gq = makeGeneratedQuestion();
    const rq = await service.importQuestion(gq, 'user-1');

    const edited = await service.editQuestion(
      gq.workspaceId,
      rq.id,
      { stem: 'With ETag', expectedEtag: rq.etag },
      'user-1',
    );
    expect(edited.version).toBe(2);
  });

  it('concurrent edit detection: throws QuestionEtagMismatchError with stale ETag', async () => {
    const gq = makeGeneratedQuestion();
    const rq = await service.importQuestion(gq, 'user-1');
    const staleEtag = rq.etag;

    // First edit succeeds and advances etag
    await service.editQuestion(gq.workspaceId, rq.id, { stem: 'Edit 1' }, 'user-1');

    // Second edit with stale etag should fail with 409
    await expect(
      service.editQuestion(
        gq.workspaceId,
        rq.id,
        { stem: 'Edit 2', expectedEtag: staleEtag },
        'user-2',
      ),
    ).rejects.toThrow(QuestionEtagMismatchError);
  });

  it('edit without If-Match succeeds (backwards-compat)', async () => {
    const gq = makeGeneratedQuestion();
    const rq = await service.importQuestion(gq, 'user-1');
    // No expectedEtag — should not throw
    const edited = await service.editQuestion(
      gq.workspaceId,
      rq.id,
      { stem: 'No etag edit' },
      'user-1',
    );
    expect(edited.version).toBe(2);
  });
});

describe('B4-04: QuestionReviewService — finalization guard', () => {
  let store: InMemoryQuestionReviewStore;
  let service: QuestionReviewService;

  beforeEach(() => {
    store = new InMemoryQuestionReviewStore();
    service = new QuestionReviewService({ store });
  });

  it('throws QuestionFinalizedError when editing a finalized question', async () => {
    const gq = makeGeneratedQuestion();
    const rq = await service.importQuestion(gq, 'user-1');

    // Accept first, then mark finalized
    await service.setStatus(gq.workspaceId, rq.id, 'accepted', 'user-1');
    await service.markAllFinalized(gq.workspaceId, gq.assessmentVersionId);

    await expect(
      service.editQuestion(gq.workspaceId, rq.id, { stem: 'Cannot edit' }, 'user-1'),
    ).rejects.toThrow(QuestionFinalizedError);
  });

  it('throws QuestionFinalizedError when deleting a finalized question', async () => {
    const gq = makeGeneratedQuestion();
    const rq = await service.importQuestion(gq, 'user-1');
    await service.setStatus(gq.workspaceId, rq.id, 'accepted', 'user-1');
    await service.markAllFinalized(gq.workspaceId, gq.assessmentVersionId);

    await expect(
      service.deleteQuestion(gq.workspaceId, rq.id, 'user-1'),
    ).rejects.toThrow(QuestionFinalizedError);
  });
});
