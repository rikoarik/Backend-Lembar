/**
 * B5-02 — Tests: PDF artifact lifecycle.
 *
 * Evidence covered:
 * - isolated render: artifact stored privately with workspace-scoped key
 * - private artifact: workspace B cannot access workspace A's artifact
 * - deterministic reuse: same HTML content → same hash → no re-render (reused=true)
 * - authorized download: getArtifactInfo returns signed URL
 * - deleteArtifactForAssessment: cleans up artifact record and storage
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';

import { InMemoryAssessmentsStore } from '../../../src/modules/assessments/persistence/InMemoryAssessmentsStore.js';
import { InMemoryQuestionReviewStore } from '../../../src/modules/assessments/persistence/InMemoryQuestionReviewStore.js';
import { InMemoryPrintArtifactStore } from '../../../src/modules/assessments/persistence/InMemoryPrintArtifactStore.js';
import { QuestionReviewService } from '../../../src/modules/assessments/application/QuestionReviewService.js';
import { FinalizationService } from '../../../src/modules/assessments/application/FinalizationService.js';
import { PrintService } from '../../../src/modules/assessments/application/PrintService.js';
import { PrintArtifactService } from '../../../src/modules/assessments/application/PrintArtifactService.js';
import { LocalFilesystemAdapter } from '../../../src/infrastructure/storage/LocalFilesystemAdapter.js';
import type { GeneratedQuestion } from '../../../src/modules/assessments/domain/QuestionGeneration.js';

const WS_A = 'ws-artifact-A';
const WS_B = 'ws-artifact-B';
const CREATOR = 'user-001';
const FIXED_NOW = '2025-01-01T00:00:00.000Z';

function makeGQ(id: string, seq: number, wsId: string, avId: string): GeneratedQuestion {
  return {
    id,
    assessmentVersionId: avId,
    workspaceId: wsId,
    blueprintSequence: seq,
    questionType: 'multiple_choice',
    difficulty: 'easy',
    stem: `Q${seq}?`,
    options: [{ key: 'A', text: 'Yes' }, { key: 'B', text: 'No' }],
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
  };
}

async function makeFinalisedAssessment(
  assessmentsStore: InMemoryAssessmentsStore,
  reviewStore: InMemoryQuestionReviewStore,
  wsId = WS_A,
): Promise<{ assessmentId: string }> {
  const assessment = await assessmentsStore.createAssessment({
    workspaceId: wsId,
    creatorUserId: CREATOR,
    title: 'Test Assessment',
  });

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

  await assessmentsStore.updateAssessment({
    id: assessment.id,
    workspaceId: wsId,
    currentVersion: 1,
    status: 'ready',
  });

  const reviewService = new QuestionReviewService({ store: reviewStore });
  const gq = makeGQ('gq-1', 0, wsId, version.id);
  const rq = await reviewService.importQuestion(gq, CREATOR);
  await reviewService.setStatus(wsId, rq.id, 'accepted', CREATOR);

  const finalizationService = new FinalizationService({ store: reviewStore, reviewService });
  await finalizationService.finalizeAssessmentVersion(wsId, version.id, CREATOR);

  return { assessmentId: assessment.id };
}

async function makeServices(rootDir: string) {
  const assessmentsStore = new InMemoryAssessmentsStore();
  const reviewStore = new InMemoryQuestionReviewStore();
  const artifactStore = new InMemoryPrintArtifactStore();
  const storage = new LocalFilesystemAdapter(rootDir, { signingSecret: 'test-secret' });

  const printService = new PrintService({
    assessmentsStore,
    reviewStore,
    clock: () => new Date(FIXED_NOW),
  });

  const artifactService = new PrintArtifactService({
    artifactStore,
    storage,
    printService,
    clock: () => new Date(FIXED_NOW),
  });

  return { assessmentsStore, reviewStore, artifactStore, storage, printService, artifactService };
}

describe('B5-02: PrintArtifactService — isolated render', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'lembar-artifact-'));
  });

  it('stores artifact with workspace-scoped storage key', async () => {
    const { assessmentsStore, reviewStore, artifactService } = await makeServices(rootDir);
    const { assessmentId } = await makeFinalisedAssessment(assessmentsStore, reviewStore, WS_A);

    const result = await artifactService.triggerRender(WS_A, assessmentId, 'req-1');

    expect(result.artifact.status).toBe('ready');
    expect(result.artifact.workspaceId).toBe(WS_A);
    expect(result.artifact.storageKey).toContain(WS_A);
    expect(result.artifact.storageKey).toContain(assessmentId);
    expect(result.artifact.byteSize).toBeGreaterThan(0);
  });

  it('deterministic reuse: same HTML content returns reused=true', async () => {
    const { assessmentsStore, reviewStore, artifactService } = await makeServices(rootDir);
    const { assessmentId } = await makeFinalisedAssessment(assessmentsStore, reviewStore, WS_A);

    const first = await artifactService.triggerRender(WS_A, assessmentId, 'req-1');
    expect(first.reused).toBe(false);

    const second = await artifactService.triggerRender(WS_A, assessmentId, 'req-2');
    expect(second.reused).toBe(true);
    expect(second.artifact.id).toBe(first.artifact.id);
    expect(second.artifact.contentHash).toBe(first.artifact.contentHash);
  });

  it('getArtifactInfo returns signed download URL', async () => {
    const { assessmentsStore, reviewStore, artifactService } = await makeServices(rootDir);
    const { assessmentId } = await makeFinalisedAssessment(assessmentsStore, reviewStore, WS_A);

    await artifactService.triggerRender(WS_A, assessmentId, 'req-1');
    const info = await artifactService.getArtifactInfo(WS_A, assessmentId, 'req-2');

    expect(info.downloadUrl).toBeTruthy();
    expect(info.expiresAtEpochMs).toBeGreaterThan(Date.now());
    expect(info.artifact.status).toBe('ready');
  });

  it('getArtifactInfo throws RESOURCE_NOT_FOUND if no artifact yet', async () => {
    const { assessmentsStore, reviewStore, artifactService } = await makeServices(rootDir);
    const { assessmentId } = await makeFinalisedAssessment(assessmentsStore, reviewStore, WS_A);

    await expect(
      artifactService.getArtifactInfo(WS_A, assessmentId, 'req-1'),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});

describe('B5-02: PrintArtifactService — private artifact / tenant isolation', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'lembar-artifact-'));
  });

  it('workspace B cannot access workspace A artifact', async () => {
    const { assessmentsStore, reviewStore, artifactService } = await makeServices(rootDir);
    const { assessmentId } = await makeFinalisedAssessment(assessmentsStore, reviewStore, WS_A);

    await artifactService.triggerRender(WS_A, assessmentId, 'req-1');

    // WS_B tries to get artifact info for WS_A's assessment
    await expect(
      artifactService.getArtifactInfo(WS_B, assessmentId, 'req-2'),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('artifact deleted when assessment deleted', async () => {
    const { assessmentsStore, reviewStore, artifactStore, artifactService } = await makeServices(rootDir);
    const { assessmentId } = await makeFinalisedAssessment(assessmentsStore, reviewStore, WS_A);

    await artifactService.triggerRender(WS_A, assessmentId, 'req-1');
    const before = await artifactStore.findByAssessment(WS_A, assessmentId);
    expect(before).not.toBeNull();

    await artifactService.deleteArtifactForAssessment(WS_A, assessmentId);

    const after = await artifactStore.findByAssessment(WS_A, assessmentId);
    expect(after).toBeNull();
  });
});
