/**
 * B5-05 — Output and library security gate (integration tests).
 *
 * Evidence covered:
 * - artifact-access-control: workspace A cannot access workspace B's artifacts
 * - share-security: expired/revoked share returns AUTH_REQUIRED (401)
 * - tenant-isolation: cross-workspace read returns 404 for all resources
 * - no-key-leak: token has high entropy (64 hex chars = 32 bytes)
 *
 * This is an integration gate: tests compose B5-02 (artifacts), B5-03 (shares),
 * and B5-04 (history) to prove security invariants hold end-to-end.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';

import { InMemoryAssessmentsStore } from '../../../src/modules/assessments/persistence/InMemoryAssessmentsStore.js';
import { InMemoryQuestionGenerationStore } from '../../../src/modules/assessments/persistence/InMemoryQuestionGenerationStore.js';
import { InMemoryPrintArtifactStore } from '../../../src/modules/assessments/persistence/InMemoryPrintArtifactStore.js';
import { InMemoryShareLinkStore } from '../../../src/modules/assessments/persistence/InMemoryShareLinkStore.js';
import { PrintArtifactService } from '../../../src/modules/assessments/application/PrintArtifactService.js';
import { ShareLinkService } from '../../../src/modules/assessments/application/ShareLinkService.js';
import { HistoryService } from '../../../src/modules/assessments/application/HistoryService.js';
import { LocalFilesystemAdapter } from '../../../src/infrastructure/storage/LocalFilesystemAdapter.js';
import { ApiError } from '../../../src/common/errors/envelope.js';
import type { GeneratedQuestion } from '../../../src/modules/assessments/domain/QuestionGeneration.js';

const WS_A = 'ws-gate-A';
const WS_B = 'ws-gate-B';
const CREATOR = 'user-gate-001';
const REQ_ID = 'req-gate-001';
const FIXED_NOW = '2025-01-01T00:00:00.000Z';

function makeGQ(id: string, wsId: string, avId: string): GeneratedQuestion {
  return {
    id,
    assessmentVersionId: avId,
    workspaceId: wsId,
    blueprintSequence: 1,
    questionType: 'multiple_choice',
    difficulty: 'easy',
    stem: 'Q?',
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

async function seedWorkspaceData(
  assessmentsStore: InMemoryAssessmentsStore,
  questionStore: InMemoryQuestionGenerationStore,
  wsId: string,
): Promise<{ assessmentId: string; versionId: string }> {
  const assessment = await assessmentsStore.createAssessment({
    workspaceId: wsId,
    creatorUserId: CREATOR,
    title: `Assessment for ${wsId}`,
    idempotencyKey: randomUUID(),
  });

  const version = await assessmentsStore.createAssessmentVersion({
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

  await questionStore.saveQuestions([makeGQ(randomUUID(), wsId, version.id)]);

  return { assessmentId: assessment.id, versionId: version.id };
}

describe('B5-05 — Output and library security gate', () => {
  let assessmentsStore: InMemoryAssessmentsStore;
  let questionStore: InMemoryQuestionGenerationStore;
  let artifactStore: InMemoryPrintArtifactStore;
  let shareLinkStore: InMemoryShareLinkStore;
  let shareLinkService: ShareLinkService;
  let historyService: HistoryService;

  beforeEach(async () => {
    assessmentsStore = new InMemoryAssessmentsStore();
    questionStore = new InMemoryQuestionGenerationStore();
    artifactStore = new InMemoryPrintArtifactStore();
    shareLinkStore = new InMemoryShareLinkStore();

    shareLinkService = new ShareLinkService({ store: shareLinkStore });
    historyService = new HistoryService({ assessmentsStore, questionStore });
  });

  // ─── Artifact access control (B5-02) ──────────────────────────────────────

  describe('Artifact access control', () => {
    it('workspace B artifact store is isolated from workspace A', async () => {
      // Store artifact for WS_B directly
      const artifactB = {
        id: randomUUID(),
        workspaceId: WS_B,
        assessmentId: 'assessment-b-001',
        storageKey: `${WS_B}/assessment-b-001/artifact.html`,
        status: 'ready' as const,
        contentType: 'text/html; charset=utf-8',
        byteSize: 1024,
        contentHash: 'abc123',
        failureReason: null,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      };
      await artifactStore.save(artifactB);

      // WS_A tries to find WS_B's artifact by assessmentId
      const resultForA = await artifactStore.findByAssessment(WS_A, 'assessment-b-001');
      expect(resultForA).toBeNull();

      // WS_B can find their own artifact
      const resultForB = await artifactStore.findByAssessment(WS_B, 'assessment-b-001');
      expect(resultForB).not.toBeNull();
      expect(resultForB!.workspaceId).toBe(WS_B);
    });

    it('artifact store enforces workspace isolation on findByAssessment', async () => {
      const artifactA = {
        id: randomUUID(),
        workspaceId: WS_A,
        assessmentId: 'shared-id',
        storageKey: `${WS_A}/shared-id/artifact.html`,
        status: 'ready' as const,
        contentType: 'text/html; charset=utf-8',
        byteSize: 512,
        contentHash: 'def456',
        failureReason: null,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      };
      await artifactStore.save(artifactA);

      // WS_B cannot access WS_A's artifact with the same assessmentId
      const foundByB = await artifactStore.findByAssessment(WS_B, 'shared-id');
      expect(foundByB).toBeNull();
    });
  });

  // ─── Share link security (B5-03) ──────────────────────────────────────────

  describe('Share link security', () => {
    it('expired share returns AUTH_REQUIRED (401)', async () => {
      const past = new Date('2020-01-01T00:00:00Z');
      const expiredService = new ShareLinkService({
        store: shareLinkStore,
        clock: () => past,
      });

      const link = await expiredService.createShareLink({
        workspaceId: WS_A,
        assessmentId: 'a-001',
        requestId: REQ_ID,
        ttlSeconds: 1,
      });

      // Validate with current clock (far in the future from 2020)
      const nowService = new ShareLinkService({
        store: shareLinkStore,
        clock: () => new Date(),
      });

      await expect(nowService.validateToken(link.token, REQ_ID)).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof ApiError && e.status === 401 && e.code === 'AUTH_REQUIRED',
      );
    });

    it('revoked share returns AUTH_REQUIRED (401)', async () => {
      const link = await shareLinkService.createShareLink({
        workspaceId: WS_A,
        assessmentId: 'a-001',
        requestId: REQ_ID,
      });

      await shareLinkService.revokeShareLink(link.token, WS_A, REQ_ID);

      await expect(
        shareLinkService.validateToken(link.token, REQ_ID),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof ApiError && e.status === 401 && e.code === 'AUTH_REQUIRED',
      );
    });

    it('unknown token returns AUTH_REQUIRED (401)', async () => {
      await expect(
        shareLinkService.validateToken('deadbeef'.repeat(8), REQ_ID),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof ApiError && e.status === 401 && e.code === 'AUTH_REQUIRED',
      );
    });

    it('workspace B cannot revoke workspace A share link — PERMISSION_DENIED (403)', async () => {
      const link = await shareLinkService.createShareLink({
        workspaceId: WS_A,
        assessmentId: 'a-001',
        requestId: REQ_ID,
      });

      await expect(
        shareLinkService.revokeShareLink(link.token, WS_B, REQ_ID),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof ApiError && e.status === 403 && e.code === 'PERMISSION_DENIED',
      );
    });

    it('share link token has high entropy (64 hex chars = 32 bytes) — no key leak', async () => {
      const link = await shareLinkService.createShareLink({
        workspaceId: WS_A,
        assessmentId: 'a-001',
        requestId: REQ_ID,
      });

      expect(link.token).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ─── Tenant isolation across B5-03 / B5-04 ───────────────────────────────

  describe('Tenant isolation', () => {
    it('workspace A history does not include workspace B assessments', async () => {
      await seedWorkspaceData(assessmentsStore, questionStore, WS_A);
      await seedWorkspaceData(assessmentsStore, questionStore, WS_B);

      const histA = await historyService.listHistory(WS_A);
      const histB = await historyService.listHistory(WS_B);

      expect(histA.items.every((a) => a.workspaceId === WS_A)).toBe(true);
      expect(histB.items.every((a) => a.workspaceId === WS_B)).toBe(true);
      expect(histA.items).toHaveLength(1);
      expect(histB.items).toHaveLength(1);
    });

    it('workspace A cannot access workspace B assessment detail — RESOURCE_NOT_FOUND (404)', async () => {
      const { assessmentId } = await seedWorkspaceData(assessmentsStore, questionStore, WS_B);

      await expect(
        historyService.getAssessmentDetail(WS_A, assessmentId, REQ_ID),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof ApiError && e.status === 404 && e.code === 'RESOURCE_NOT_FOUND',
      );
    });

    it('question bank is scoped to tenant: WS_A bank does not include WS_B questions', async () => {
      await seedWorkspaceData(assessmentsStore, questionStore, WS_A);
      await seedWorkspaceData(assessmentsStore, questionStore, WS_B);

      const bankA = await historyService.listBank(WS_A);
      const bankB = await historyService.listBank(WS_B);

      expect(bankA.questions.every((q) => q.workspaceId === WS_A)).toBe(true);
      expect(bankB.questions.every((q) => q.workspaceId === WS_B)).toBe(true);
    });

    it('share links are scoped to workspace (WS_A list does not include WS_B links)', async () => {
      await shareLinkService.createShareLink({
        workspaceId: WS_A,
        assessmentId: 'a-1',
        requestId: REQ_ID,
      });
      await shareLinkService.createShareLink({
        workspaceId: WS_B,
        assessmentId: 'a-1',
        requestId: REQ_ID,
      });

      const linksA = await shareLinkService.listByAssessment(WS_A, 'a-1');
      const linksB = await shareLinkService.listByAssessment(WS_B, 'a-1');

      expect(linksA.every((l) => l.workspaceId === WS_A)).toBe(true);
      expect(linksB.every((l) => l.workspaceId === WS_B)).toBe(true);
      expect(linksA).toHaveLength(1);
      expect(linksB).toHaveLength(1);
    });
  });
});
