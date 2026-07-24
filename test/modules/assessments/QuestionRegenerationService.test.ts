/**
 * B4-02 — Tests: Targeted question regeneration (candidate management).
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { InMemoryQuestionReviewStore } from '../../../src/modules/assessments/persistence/InMemoryQuestionReviewStore.js';
import {
  QuestionReviewService,
  QuestionNotFoundError,
  QuestionNoCandidateError,
  QuestionFinalizedError,
} from '../../../src/modules/assessments/application/QuestionReviewService.js';
import type { GeneratedQuestion } from '../../../src/modules/assessments/domain/QuestionGeneration.js';

function makeGQ(overrides: Partial<GeneratedQuestion> = {}): GeneratedQuestion {
  return {
    id: 'gq-001',
    assessmentVersionId: 'av-001',
    workspaceId: 'ws-001',
    blueprintSequence: 0,
    questionType: 'multiple_choice',
    difficulty: 'medium',
    stem: 'Original stem?',
    options: [{ key: 'A', text: 'Option A' }, { key: 'B', text: 'Option B' }],
    answer: 'A',
    explanation: 'Original explanation.',
    sourceIds: ['src-1'],
    versionMetadata: {
      blueprintSchemaVersion: '1.0.0',
      providerModelId: 'gpt-4o',
      promptTemplateId: 'v1',
      schemaRepairAttempts: 0,
      latencyMs: 200,
    },
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('B4-02: Targeted question regeneration', () => {
  let store: InMemoryQuestionReviewStore;
  let service: QuestionReviewService;

  beforeEach(() => {
    store = new InMemoryQuestionReviewStore();
    service = new QuestionReviewService({ store });
  });

  it('createCandidate: original preserved and candidate created', async () => {
    const gq = makeGQ();
    const original = await service.importQuestion(gq, 'user-1');

    const { original: orig, candidate, created } = await service.createCandidate(
      gq.workspaceId,
      original.id,
      'user-1',
    );

    expect(created).toBe(true);
    expect(orig.id).toBe(original.id);
    expect(orig.candidateId).toBe(candidate.id);
    expect(candidate.id).not.toBe(original.id);
    // Original question still exists and is active
    const fetched = await service.getQuestion(gq.workspaceId, original.id);
    expect(fetched.candidateId).toBe(candidate.id);
    expect(fetched.stem).toBe('Original stem?');
  });

  it('createCandidate is idempotent — same candidate returned on second call', async () => {
    const gq = makeGQ();
    const original = await service.importQuestion(gq, 'user-1');

    const r1 = await service.createCandidate(gq.workspaceId, original.id, 'user-1');
    const r2 = await service.createCandidate(gq.workspaceId, original.id, 'user-1');

    expect(r1.candidate.id).toBe(r2.candidate.id);
    expect(r2.created).toBe(false);
  });

  it('acceptCandidate: candidate content merged into original, original becomes accepted', async () => {
    const gq = makeGQ();
    const original = await service.importQuestion(gq, 'user-1');
    await service.createCandidate(gq.workspaceId, original.id, 'user-1');

    const accepted = await service.acceptCandidate(gq.workspaceId, original.id, 'user-1');

    expect(accepted.id).toBe(original.id);
    expect(accepted.status).toBe('accepted');
    expect(accepted.candidateId).toBeNull();
    // Source integrity preserved
    expect(accepted.sourceIds).toEqual(gq.sourceIds);
  });

  it('acceptCandidate: candidate record deleted after accept', async () => {
    const gq = makeGQ();
    const original = await service.importQuestion(gq, 'user-1');
    const { candidate } = await service.createCandidate(gq.workspaceId, original.id, 'user-1');

    await service.acceptCandidate(gq.workspaceId, original.id, 'user-1');

    // Candidate should no longer exist
    const fetched = await store.findById(gq.workspaceId, candidate.id);
    expect(fetched).toBeNull();
  });

  it('rejectCandidate: original unchanged, candidate deleted, candidateId cleared', async () => {
    const gq = makeGQ();
    const original = await service.importQuestion(gq, 'user-1');
    const { candidate } = await service.createCandidate(gq.workspaceId, original.id, 'user-1');

    const restored = await service.rejectCandidate(gq.workspaceId, original.id, 'user-1');

    expect(restored.id).toBe(original.id);
    expect(restored.candidateId).toBeNull();
    expect(restored.status).toBe('pending'); // status unchanged

    // Candidate gone
    const gone = await store.findById(gq.workspaceId, candidate.id);
    expect(gone).toBeNull();
  });

  it('acceptCandidate: throws QuestionNoCandidateError if no candidate', async () => {
    const gq = makeGQ();
    const original = await service.importQuestion(gq, 'user-1');

    await expect(
      service.acceptCandidate(gq.workspaceId, original.id, 'user-1'),
    ).rejects.toThrow(QuestionNoCandidateError);
  });

  it('createCandidate: throws QuestionFinalizedError on finalized question', async () => {
    const gq = makeGQ();
    const original = await service.importQuestion(gq, 'user-1');
    await service.setStatus(gq.workspaceId, original.id, 'accepted', 'user-1');
    await service.markAllFinalized(gq.workspaceId, gq.assessmentVersionId);

    await expect(
      service.createCandidate(gq.workspaceId, original.id, 'user-1'),
    ).rejects.toThrow(QuestionFinalizedError);
  });

  it('createCandidate: throws QuestionNotFoundError for unknown question', async () => {
    await expect(
      service.createCandidate('ws-001', 'ghost-id', 'user-1'),
    ).rejects.toThrow(QuestionNotFoundError);
  });

  it('candidate_created/accepted audit entries appended', async () => {
    const gq = makeGQ();
    const original = await service.importQuestion(gq, 'user-1');
    await service.createCandidate(gq.workspaceId, original.id, 'user-1');
    await service.acceptCandidate(gq.workspaceId, original.id, 'user-1');

    const log = await service.getAuditLog(gq.workspaceId, original.id);
    const actions = log.map((e) => e.action);
    expect(actions).toContain('candidate_created');
    expect(actions).toContain('candidate_accepted');
  });
});
