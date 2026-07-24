/**
 * B5-01 — Tests: PrintDocument DTO and template contract.
 *
 * Evidence covered:
 * - print DTO shape correct (all required fields, dtoVersion, tenant isolation)
 * - tenant isolation: workspace A cannot get workspace B's print document
 * - 409 if assessment not finalized
 * - 404 if assessment not found
 * - questions sorted by blueprintSequence
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { InMemoryAssessmentsStore } from '../../../src/modules/assessments/persistence/InMemoryAssessmentsStore.js';
import { InMemoryQuestionReviewStore } from '../../../src/modules/assessments/persistence/InMemoryQuestionReviewStore.js';
import { QuestionReviewService } from '../../../src/modules/assessments/application/QuestionReviewService.js';
import { FinalizationService } from '../../../src/modules/assessments/application/FinalizationService.js';
import { PrintService } from '../../../src/modules/assessments/application/PrintService.js';
import { PRINT_DTO_VERSION } from '../../../src/modules/assessments/domain/PrintDocument.js';
import { renderPrintHtml } from '../../../src/modules/assessments/application/printTemplate.js';
import type { GeneratedQuestion } from '../../../src/modules/assessments/domain/QuestionGeneration.js';

const WS_A = 'ws-tenant-A';
const WS_B = 'ws-tenant-B';
const CREATOR = 'user-001';
const FIXED_NOW = '2025-01-01T00:00:00.000Z';

function makeGQ(id: string, seq: number, wsId: string, avId: string): GeneratedQuestion {
  return {
    id,
    assessmentVersionId: avId,
    workspaceId: wsId,
    blueprintSequence: seq,
    questionType: 'multiple_choice',
    difficulty: 'medium',
    stem: `Question ${seq}?`,
    options: [
      { key: 'A', text: 'Option A' },
      { key: 'B', text: 'Option B' },
    ],
    answer: 'A',
    explanation: 'Because A.',
    sourceIds: [],
    versionMetadata: {
      blueprintSchemaVersion: '1.0.0',
      providerModelId: 'gpt-4o',
      promptTemplateId: 'v1',
      schemaRepairAttempts: 0,
      latencyMs: 50,
    },
    createdAt: FIXED_NOW,
  };
}

async function makeFinalisedAssessment(
  assessmentsStore: InMemoryAssessmentsStore,
  reviewStore: InMemoryQuestionReviewStore,
  wsId = WS_A,
): Promise<{ assessmentId: string }> {
  // Create assessment — store assigns random id
  const assessment = await assessmentsStore.createAssessment({
    workspaceId: wsId,
    creatorUserId: CREATOR,
    title: 'Soal Matematika Kelas 7',
    idempotencyKey: null,
  });

  // Create version — store assigns random id
  const version = await assessmentsStore.createAssessmentVersion({
    assessmentId: assessment.id,
    workspaceId: wsId,
    version: 1,
    configSnapshot: {
      schemaVersion: '1',
      title: assessment.title,
      curriculumVersionId: 'cv-1',
      gradeId: 'g-7',
      subjectId: 's-math',
      sourceUploadIds: [],
      blueprintItems: [],
    },
  });

  // Update assessment to point at version 1
  await assessmentsStore.updateAssessment({
    id: assessment.id,
    workspaceId: wsId,
    currentVersion: 1,
    status: 'ready',
  });

  // Import and accept questions
  const reviewService = new QuestionReviewService({ store: reviewStore });
  const gq0 = makeGQ('gq-0', 0, wsId, version.id);
  const gq1 = makeGQ('gq-1', 1, wsId, version.id);
  const rq0 = await reviewService.importQuestion(gq0, CREATOR);
  const rq1 = await reviewService.importQuestion(gq1, CREATOR);
  await reviewService.setStatus(wsId, rq0.id, 'accepted', CREATOR);
  await reviewService.setStatus(wsId, rq1.id, 'accepted', CREATOR);

  // Finalize
  const finalizationService = new FinalizationService({ store: reviewStore, reviewService });
  await finalizationService.finalizeAssessmentVersion(wsId, version.id, CREATOR);

  return { assessmentId: assessment.id };
}

describe('B5-01: PrintService — DTO shape', () => {
  let assessmentsStore: InMemoryAssessmentsStore;
  let reviewStore: InMemoryQuestionReviewStore;
  let printService: PrintService;

  beforeEach(() => {
    assessmentsStore = new InMemoryAssessmentsStore();
    reviewStore = new InMemoryQuestionReviewStore();
    printService = new PrintService({
      assessmentsStore,
      reviewStore,
      clock: () => new Date(FIXED_NOW),
    });
  });

  it('returns a PrintDocument with correct dtoVersion', async () => {
    const { assessmentId } = await makeFinalisedAssessment(assessmentsStore, reviewStore);
    const doc = await printService.buildPrintDocument(WS_A, assessmentId, 'req-1');

    expect(doc.meta.dtoVersion).toBe(PRINT_DTO_VERSION);
    expect(doc.meta.assessmentId).toBe(assessmentId);
    expect(doc.meta.workspaceId).toBe(WS_A);
    expect(doc.meta.generatedAt).toBe(FIXED_NOW);
    expect(typeof doc.meta.title).toBe('string');
    expect(typeof doc.meta.finalizedAt).toBe('string');
  });

  it('questions are ordered by blueprintSequence ascending', async () => {
    const { assessmentId } = await makeFinalisedAssessment(assessmentsStore, reviewStore);
    const doc = await printService.buildPrintDocument(WS_A, assessmentId, 'req-1');

    expect(doc.questions).toHaveLength(2);
    expect(doc.questions[0]!.sequence).toBe(0);
    expect(doc.questions[1]!.sequence).toBe(1);
  });

  it('each question has stem, options, answer, explanation', async () => {
    const { assessmentId } = await makeFinalisedAssessment(assessmentsStore, reviewStore);
    const doc = await printService.buildPrintDocument(WS_A, assessmentId, 'req-1');

    const q = doc.questions[0]!;
    expect(q.stem).toBeDefined();
    expect(q.options.length).toBeGreaterThan(0);
    expect(q.answer).toBeDefined();
    expect(q.explanation).toBeDefined();
  });

  it('throws STATE_CONFLICT (409) if assessment is not finalized', async () => {
    const assessment = await assessmentsStore.createAssessment({
      workspaceId: WS_A,
      creatorUserId: CREATOR,
      title: 'Not finalized',
    });
    await assessmentsStore.createAssessmentVersion({
      assessmentId: assessment.id,
      workspaceId: WS_A,
      version: 1,
      configSnapshot: {
        schemaVersion: '1',
        title: 'Not finalized',
        curriculumVersionId: 'cv-1',
        gradeId: 'g-7',
        subjectId: 's-math',
        sourceUploadIds: [],
        blueprintItems: [],
      },
    });
    await assessmentsStore.updateAssessment({
      id: assessment.id,
      workspaceId: WS_A,
      currentVersion: 1,
      status: 'ready',
    });

    await expect(
      printService.buildPrintDocument(WS_A, assessment.id, 'req-1'),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  });

  it('throws RESOURCE_NOT_FOUND (404) for unknown assessment', async () => {
    await expect(
      printService.buildPrintDocument(WS_A, 'nonexistent-id', 'req-1'),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});

describe('B5-01: PrintService — tenant isolation', () => {
  let assessmentsStore: InMemoryAssessmentsStore;
  let reviewStore: InMemoryQuestionReviewStore;
  let printService: PrintService;

  beforeEach(() => {
    assessmentsStore = new InMemoryAssessmentsStore();
    reviewStore = new InMemoryQuestionReviewStore();
    printService = new PrintService({
      assessmentsStore,
      reviewStore,
      clock: () => new Date(FIXED_NOW),
    });
  });

  it('workspace B cannot access workspace A assessment', async () => {
    const { assessmentId } = await makeFinalisedAssessment(assessmentsStore, reviewStore, WS_A);

    // WS_B tries to access WS_A's assessment — must get RESOURCE_NOT_FOUND
    await expect(
      printService.buildPrintDocument(WS_B, assessmentId, 'req-2'),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});

describe('B5-01: printTemplate — HTML output', () => {
  it('renders valid A4 HTML with assessment title and questions', () => {
    const doc = {
      meta: {
        dtoVersion: PRINT_DTO_VERSION,
        assessmentId: 'a-001',
        assessmentVersion: 1,
        workspaceId: WS_A,
        title: 'Test Assessment',
        finalizedAt: FIXED_NOW,
        generatedAt: FIXED_NOW,
      },
      questions: [
        {
          sequence: 0,
          questionType: 'multiple_choice' as const,
          difficulty: 'easy' as const,
          stem: 'What is 2+2?',
          options: [{ key: 'A', text: '4' }],
          answer: 'A',
          explanation: 'Basic math.',
        },
      ],
    };

    const html = renderPrintHtml(doc);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Test Assessment');
    expect(html).toContain('What is 2+2?');
    expect(html).toContain('A4');
  });

  it('escapes HTML entities in user content', () => {
    const doc = {
      meta: {
        dtoVersion: PRINT_DTO_VERSION,
        assessmentId: 'a-001',
        assessmentVersion: 1,
        workspaceId: WS_A,
        title: '<script>alert(1)</script>',
        finalizedAt: FIXED_NOW,
        generatedAt: FIXED_NOW,
      },
      questions: [],
    };

    const html = renderPrintHtml(doc);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
