/**
 * B5-04 — Tests: History, private bank, and question snapshots.
 *
 * Evidence covered:
 * - tenant isolation: workspace A cannot see workspace B assessments
 * - snapshots preserved: question data immutable after creation
 * - pagination: limit + cursor works correctly
 * - bank: cross-assessment question aggregation per tenant
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { InMemoryAssessmentsStore } from '../../../src/modules/assessments/persistence/InMemoryAssessmentsStore.js';
import { InMemoryQuestionGenerationStore } from '../../../src/modules/assessments/persistence/InMemoryQuestionGenerationStore.js';
import { HistoryService } from '../../../src/modules/assessments/application/HistoryService.js';
import { ApiError } from '../../../src/common/errors/envelope.js';
import type { GeneratedQuestion } from '../../../src/modules/assessments/domain/QuestionGeneration.js';

const WS_A = 'ws-history-A';
const WS_B = 'ws-history-B';
const CREATOR = 'user-history-001';
const REQ_ID = 'req-hist-001';
const FIXED_NOW = '2025-01-01T00:00:00.000Z';

async function seedAssessment(
  store: InMemoryAssessmentsStore,
  qStore: InMemoryQuestionGenerationStore,
  wsId: string,
  questionCount: number = 2,
): Promise<{ assessmentId: string; versionId: string }> {
  const assessment = await store.createAssessment({
    workspaceId: wsId,
    creatorUserId: CREATOR,
    title: `Assessment for ${wsId}`,
    idempotencyKey: randomUUID(),
  });

  const version = await store.createAssessmentVersion({
    assessmentId: assessment.id,
    workspaceId: wsId,
    version: 1,
    configSnapshot: {
      title: assessment.title,
      curriculumVersionId: 'cv-1',
      gradeId: 'g-1',
      subjectId: 's-1',
      sourceUploadIds: [],
      blueprintItems: [],
      schemaVersion: '1',
    },
  });

  const questions: GeneratedQuestion[] = Array.from({ length: questionCount }, (_, i) => ({
    id: randomUUID(),
    assessmentVersionId: version.id,
    workspaceId: wsId,
    blueprintSequence: i + 1,
    questionType: 'multiple_choice' as const,
    difficulty: 'easy' as const,
    stem: `Question ${i + 1} for ${wsId}?`,
    options: [
      { key: 'A', text: 'Yes' },
      { key: 'B', text: 'No' },
    ],
    answer: 'A',
    explanation: 'A is correct.',
    sourceIds: [],
    versionMetadata: {
      blueprintSchemaVersion: '1',
      providerModelId: 'gpt-4o',
      promptTemplateId: 'v1',
      schemaRepairAttempts: 0,
      latencyMs: 10,
    },
    createdAt: FIXED_NOW,
  }));

  await qStore.saveQuestions(questions);

  return { assessmentId: assessment.id, versionId: version.id };
}

function makeService() {
  const assessmentsStore = new InMemoryAssessmentsStore();
  const questionStore = new InMemoryQuestionGenerationStore();
  const service = new HistoryService({ assessmentsStore, questionStore });
  return { assessmentsStore, questionStore, service };
}

describe('HistoryService', () => {
  let assessmentsStore: InMemoryAssessmentsStore;
  let questionStore: InMemoryQuestionGenerationStore;
  let service: HistoryService;

  beforeEach(() => {
    ({ assessmentsStore, questionStore, service } = makeService());
  });

  describe('listHistory', () => {
    it('returns only assessments belonging to requesting workspace (tenant isolation)', async () => {
      await seedAssessment(assessmentsStore, questionStore, WS_A);
      await seedAssessment(assessmentsStore, questionStore, WS_B);

      const pageA = await service.listHistory(WS_A);
      const pageB = await service.listHistory(WS_B);

      expect(pageA.items).toHaveLength(1);
      expect(pageA.items[0]!.workspaceId).toBe(WS_A);
      expect(pageB.items).toHaveLength(1);
      expect(pageB.items[0]!.workspaceId).toBe(WS_B);
    });

    it('returns empty list for workspace with no assessments', async () => {
      const page = await service.listHistory('ws-empty');
      expect(page.items).toHaveLength(0);
      expect(page.nextCursor).toBeNull();
      expect(page.total).toBe(0);
    });

    it('paginates with limit', async () => {
      // Create 3 assessments
      await seedAssessment(assessmentsStore, questionStore, WS_A);
      await seedAssessment(assessmentsStore, questionStore, WS_A);
      await seedAssessment(assessmentsStore, questionStore, WS_A);

      const page = await service.listHistory(WS_A, 2);
      expect(page.items).toHaveLength(2);
      expect(page.total).toBe(3);
      expect(page.nextCursor).not.toBeNull();
    });

    it('returns nextCursor=null when all items fit in one page', async () => {
      await seedAssessment(assessmentsStore, questionStore, WS_A);

      const page = await service.listHistory(WS_A, 20);
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeNull();
    });
  });

  describe('getAssessmentDetail', () => {
    it('returns assessment with question snapshots (snapshots preserved)', async () => {
      const { assessmentId } = await seedAssessment(assessmentsStore, questionStore, WS_A, 3);

      const detail = await service.getAssessmentDetail(WS_A, assessmentId, REQ_ID);

      expect(detail.assessment.id).toBe(assessmentId);
      expect(detail.assessment.workspaceId).toBe(WS_A);
      expect(detail.version).not.toBeNull();
      expect(detail.questions).toHaveLength(3);
      // Snapshots are preserved: question data intact
      expect(detail.questions[0]!.stem).toContain('Question 1');
      expect(detail.questions[0]!.workspaceId).toBe(WS_A);
    });

    it('throws RESOURCE_NOT_FOUND for unknown assessment', async () => {
      await expect(
        service.getAssessmentDetail(WS_A, 'non-existent-id', REQ_ID),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof ApiError && e.status === 404 && e.code === 'RESOURCE_NOT_FOUND',
      );
    });

    it('throws RESOURCE_NOT_FOUND for cross-workspace access (tenant isolation)', async () => {
      const { assessmentId } = await seedAssessment(assessmentsStore, questionStore, WS_A);

      // WS_B tries to access WS_A's assessment
      await expect(
        service.getAssessmentDetail(WS_B, assessmentId, REQ_ID),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof ApiError && e.status === 404 && e.code === 'RESOURCE_NOT_FOUND',
      );
    });

    it('returns version=null and empty questions for assessment without version', async () => {
      const assessment = await assessmentsStore.createAssessment({
        workspaceId: WS_A,
        creatorUserId: CREATOR,
        title: 'Draft',
        idempotencyKey: randomUUID(),
      });

      const detail = await service.getAssessmentDetail(WS_A, assessment.id, REQ_ID);
      expect(detail.version).toBeNull();
      expect(detail.questions).toHaveLength(0);
    });
  });

  describe('listBank', () => {
    it('returns only questions from requesting workspace (tenant isolation)', async () => {
      await seedAssessment(assessmentsStore, questionStore, WS_A, 2);
      await seedAssessment(assessmentsStore, questionStore, WS_B, 3);

      const bankA = await service.listBank(WS_A);
      const bankB = await service.listBank(WS_B);

      expect(bankA.questions).toHaveLength(2);
      expect(bankA.questions.every((q) => q.workspaceId === WS_A)).toBe(true);
      expect(bankB.questions).toHaveLength(3);
      expect(bankB.questions.every((q) => q.workspaceId === WS_B)).toBe(true);
    });

    it('aggregates questions across multiple assessments', async () => {
      await seedAssessment(assessmentsStore, questionStore, WS_A, 2);
      await seedAssessment(assessmentsStore, questionStore, WS_A, 3);

      const bank = await service.listBank(WS_A);
      expect(bank.questions).toHaveLength(5);
    });

    it('paginates with limit and returns nextCursor', async () => {
      await seedAssessment(assessmentsStore, questionStore, WS_A, 5);

      const page1 = await service.listBank(WS_A, 3, 0);
      expect(page1.questions).toHaveLength(3);
      expect(page1.nextCursor).toBe('3');

      const page2 = await service.listBank(WS_A, 3, 3);
      expect(page2.questions).toHaveLength(2);
      expect(page2.nextCursor).toBeNull();
    });

    it('returns empty for workspace with no questions', async () => {
      const bank = await service.listBank('ws-empty');
      expect(bank.questions).toHaveLength(0);
      expect(bank.nextCursor).toBeNull();
    });
  });
});
