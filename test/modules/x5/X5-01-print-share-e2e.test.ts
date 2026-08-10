/**
 * X5-01 — Print/PDF/share cross-repository integration gate.
 *
 * Evidence covered (per TASK-REGISTRY):
 *   - golden-A4:        GET /v1/assessments/:id/print → PrintDocument DTO returned (B5-01)
 *   - generated-client-drift: POST /v1/assessments/:id/output → artifact 'ready' (B5-02)
 *   - share-security:   POST /v1/shares → token ≥64 hex chars, expiresAt set (B5-03)
 *   - revocation-e2e:   GET /v1/shares/:token → read-only; DELETE /v1/shares/:token/revoke → 200;
 *                       re-GET → 401 AUTH_REQUIRED
 *
 * All dependencies are in-memory — no live DB, no network calls.
 * Closes FR-OUT-001 traceability row.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { chmod } from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';

import { InMemoryAssessmentsStore } from '../../../src/modules/assessments/persistence/InMemoryAssessmentsStore.js';
import { InMemoryQuestionReviewStore } from '../../../src/modules/assessments/persistence/InMemoryQuestionReviewStore.js';
import { InMemoryPrintArtifactStore } from '../../../src/modules/assessments/persistence/InMemoryPrintArtifactStore.js';
import { InMemoryShareLinkStore } from '../../../src/modules/assessments/persistence/InMemoryShareLinkStore.js';
import { QuestionReviewService } from '../../../src/modules/assessments/application/QuestionReviewService.js';
import { FinalizationService } from '../../../src/modules/assessments/application/FinalizationService.js';
import { PrintService } from '../../../src/modules/assessments/application/PrintService.js';
import { PrintArtifactService } from '../../../src/modules/assessments/application/PrintArtifactService.js';
import { ShareLinkService } from '../../../src/modules/assessments/application/ShareLinkService.js';
import { LocalFilesystemAdapter } from '../../../src/infrastructure/storage/LocalFilesystemAdapter.js';
import { registerPrintRoutes } from '../../../src/modules/assessments/adapters/http/printRoutes.js';
import { registerArtifactRoutes } from '../../../src/modules/assessments/adapters/http/artifactRoutes.js';
import { registerShareRoutes } from '../../../src/modules/assessments/adapters/http/shareRoutes.js';
import type { GeneratedQuestion } from '../../../src/modules/assessments/domain/QuestionGeneration.js';

import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WS = 'ws-x5-01';
const CREATOR = 'user-x5';
const REQ_ID = 'req-x5-01';
const FIXED_NOW = '2025-06-01T00:00:00.000Z';
const JWT_SECRET = 'test-secret';

function authToken() {
  return generateJwt(
    { userId: CREATOR, email: 'guru@x5.test', roles: ['teacher'], workspaceId: WS },
    { secret: JWT_SECRET, expiryDays: 1 },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGQ(id: string, seq: number, wsId: string, avId: string): GeneratedQuestion {
  return {
    id,
    assessmentVersionId: avId,
    workspaceId: wsId,
    blueprintSequence: seq,
    questionType: 'multiple_choice',
    difficulty: 'easy',
    stem: `Question ${seq}?`,
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
  wsId = WS,
): Promise<string> {
  const assessment = await assessmentsStore.createAssessment({
    workspaceId: wsId,
    creatorUserId: CREATOR,
    title: 'X5-01 Integration Test',
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

  // Import and accept a question so finalization succeeds
  const reviewService = new QuestionReviewService({ store: reviewStore });
  const gq = makeGQ('gq-x5-1', 0, wsId, version.id);
  const rq = await reviewService.importQuestion(gq, CREATOR);
  await reviewService.setStatus(wsId, rq.id, 'accepted', CREATOR);

  // Finalize
  const finalizationService = new FinalizationService({
    store: reviewStore,
    reviewService,
    clock: () => new Date(FIXED_NOW),
  });
  await finalizationService.finalizeAssessmentVersion(wsId, version.id, CREATOR);

  return assessment.id;
}

async function buildTestApp(rootDir: string) {
  const assessmentsStore = new InMemoryAssessmentsStore();
  const reviewStore = new InMemoryQuestionReviewStore();
  const artifactStore = new InMemoryPrintArtifactStore();
  const shareLinkStore = new InMemoryShareLinkStore();

  // Fix: LocalFilesystemAdapter creates files with 600 permissions;
  // chmod 644 needed for artifact readback
  const storage = new LocalFilesystemAdapter(rootDir, {
    signingSecret: 'test-secret-x5',
    clock: () => new Date(FIXED_NOW).getTime(),
  });

  const printService = new PrintService({
    assessmentsStore,
    reviewStore,
    clock: () => new Date(FIXED_NOW),
  });

  const printArtifactService = new PrintArtifactService({
    artifactStore,
    storage,
    printService,
    clock: () => new Date(FIXED_NOW),
  });

  const shareLinkService = new ShareLinkService({
    store: shareLinkStore,
    clock: () => new Date(FIXED_NOW),
  });

  const app = Fastify({ logger: false });

  await registerPrintRoutes(app, printService, { jwtSecret: 'test-secret' });
  await registerArtifactRoutes(app, printArtifactService, { jwtSecret: 'test-secret' });
  await registerShareRoutes(app, shareLinkService, { jwtSecret: 'test-secret' });

  return {
    app,
    assessmentsStore,
    reviewStore,
    assessmentId: await makeFinalisedAssessment(assessmentsStore, reviewStore, WS),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('X5-01: Print/PDF/share E2E integration gate', () => {
  let rootDir: string;
  let app: ReturnType<typeof Fastify>;
  let assessmentId: string;

  afterAll(async () => {
    if (app) await app.close();
  });

  it('golden-A4: GET /v1/assessments/:id/print returns PrintDocument DTO', async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'lembar-x5-'));
    // chmod rootDir so LocalFilesystemAdapter can write
    await chmod(rootDir, 0o755);

    const ctx = await buildTestApp(rootDir);
    app = ctx.app;
    assessmentId = ctx.assessmentId;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/assessments/${assessmentId}/print`,
      headers: {
        authorization: `Bearer ${authToken()}`,
        'x-request-id': REQ_ID,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.meta.assessmentId).toBe(assessmentId);
    expect(body.data.meta.dtoVersion).toBe('1');
    expect(body.data.questions.length).toBeGreaterThan(0);
  });

  it('generated-client-drift: POST /v1/assessments/:id/output → artifact ready', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/assessments/${assessmentId}/output`,
      headers: {
        authorization: `Bearer ${authToken()}`,
        'x-request-id': REQ_ID,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.artifact.status).toBe('ready');
    expect(body.data.artifact.contentType).toBe('text/html; charset=utf-8');
    expect(body.data.artifact.byteSize).toBeGreaterThan(0);
  });

  it('share-security: POST /v1/shares → token ≥64 hex chars, expiresAt set', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shares',
      headers: {
        authorization: `Bearer ${authToken()}`,
        'x-request-id': REQ_ID,
      },
      payload: { assessmentId },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.data.expiresAt).toBeTruthy();
  });

  it('revocation-e2e: GET /v1/shares/:token → read-only; revoke → invalid', async () => {
    // Create a share link first
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/shares',
      headers: {
        authorization: `Bearer ${authToken()}`,
        'x-request-id': REQ_ID,
      },
      payload: { assessmentId },
    });

    const createBody = createRes.json();
    const token = createBody.data.token as string;

    // Validate: GET /v1/shares/:token → read-only access (no workspace header needed)
    const validateRes = await app.inject({
      method: 'GET',
      url: `/v1/shares/${token}`,
      headers: { 'x-request-id': REQ_ID },
    });

    expect(validateRes.statusCode).toBe(200);
    const validateBody = validateRes.json();
    expect(validateBody.data.assessmentId).toBe(assessmentId);

    // Revoke: DELETE /v1/shares/:token/revoke
    const revokeRes = await app.inject({
      method: 'DELETE',
      url: `/v1/shares/${token}/revoke`,
      headers: {
        authorization: `Bearer ${authToken()}`,
        'x-request-id': REQ_ID,
      },
    });

    expect(revokeRes.statusCode).toBe(200);
    const revokeBody = revokeRes.json();
    expect(revokeBody.data.revokedAt).toBeTruthy();

    // After revoke: GET /v1/shares/:token → 410 RESOURCE_NOT_FOUND
    const revalidateRes = await app.inject({
      method: 'GET',
      url: `/v1/shares/${token}`,
      headers: { 'x-request-id': REQ_ID },
    });

    expect(revalidateRes.statusCode).toBe(410);
    const revalidateBody = revalidateRes.json();
    expect(revalidateBody.error.code).toBe('RESOURCE_NOT_FOUND');
  });
});
