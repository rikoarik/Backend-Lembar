/**
 * Integration coverage for the assessment seam.
 *
 * The seam is the boundary where the API process and the worker process are
 * expected to observe the same assessment data. Three behaviours are pinned:
 *
 *  1. With `DATABASE_URL` set, the API and the worker resolve the *same*
 *     Postgres database, so rows written on the worker side are readable by a
 *     separately constructed API process (read-after-write across the seam),
 *     and a job submitted through one queue store is claimable through another.
 *  2. Without `DATABASE_URL`, both processes fall back to process-local
 *     in-memory stores. The fallback is deliberately not shared — which is
 *     exactly the divergence the Postgres seam exists to remove.
 *  3. The generation/import roundtrip: one successful worker generation pass
 *     persists `generated_questions` and imports exactly one `reviewed_questions`
 *     row per persisted question; replaying the same job does not duplicate it.
 *
 * The Postgres cases are gated on `DATABASE_URL` and are meant to run through
 * `pnpm test:db` (see docs/backend/TEST-POSTGRES.md). The fallback cases run
 * everywhere.
 */
import { randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/bootstrap/app.js';
import {
  closeDatabase,
  createDatabase,
  getPool,
  type Database,
} from '../../../src/infrastructure/database/db.js';
import { InMemoryAiAuditRecorder } from '../../../src/infrastructure/ai/persistence/AiAuditRepository.js';
import { ProductAiService } from '../../../src/infrastructure/ai/application/ProductAiService.js';
import {
  MockAiAdapter,
  clearMockFixtures,
  registerMockFixture,
} from '../../../src/infrastructure/ai/adapters/mock/MockAiAdapter.js';
import { AssessmentGenerationHandler } from '../../../src/infrastructure/queue/handlers/AssessmentGenerationHandler.js';
import { createSharedQueueStore } from '../../../src/infrastructure/queue/createSharedQueueStore.js';
import { InMemoryQueueStore } from '../../../src/infrastructure/queue/adapters/memory-store.js';
import { PostgresQueueStore } from '../../../src/infrastructure/queue/adapters/pglite/PostgresQueueStore.js';
import { BlueprintPipelineService } from '../../../src/modules/assessments/application/BlueprintPipelineService.js';
import {
  QUESTION_OUTPUT_SCHEMA,
  QuestionGenerationService,
} from '../../../src/modules/assessments/application/QuestionGenerationService.js';
import { QuestionReviewService } from '../../../src/modules/assessments/application/QuestionReviewService.js';
import { InMemoryBlueprintPipelineStore } from '../../../src/modules/assessments/persistence/InMemoryBlueprintPipelineStore.js';
import { InMemoryQuestionGenerationStore } from '../../../src/modules/assessments/persistence/InMemoryQuestionGenerationStore.js';
import { InMemoryQuestionReviewStore } from '../../../src/modules/assessments/persistence/InMemoryQuestionReviewStore.js';
import { PostgresAssessmentsStore } from '../../../src/modules/assessments/persistence/PostgresAssessmentsStore.js';
import { PostgresQuestionGenerationStore } from '../../../src/modules/assessments/persistence/PostgresQuestionGenerationStore.js';
import { PostgresQuestionReviewStore } from '../../../src/modules/assessments/persistence/PostgresQuestionReviewStore.js';
import { InMemorySourceRetrievalStore } from '../../../src/modules/sources/persistence/InMemorySourceRetrievalStore.js';
import { SourceRetrievalService } from '../../../src/modules/sources/application/SourceRetrievalService.js';
import type { AiEnv } from '../../../src/config/ai.env.js';
import type { JobContext } from '../../../src/infrastructure/queue/domain/JobHandler.js';
import type { AssessmentsStore } from '../../../src/modules/assessments/domain/Assessment.js';
import type { QuestionGenerationStore } from '../../../src/modules/assessments/domain/QuestionGeneration.js';
import type { QuestionReviewStore } from '../../../src/modules/assessments/domain/QuestionReview.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const HAS_DB = Boolean(DATABASE_URL);
const JWT_SECRET = 'assessment-seam-integration-secret';

/**
 * `buildApp()` resolves the route secret from `process.env.JWT_SECRET`
 * (src/bootstrap/app.ts:496 -> `assessmentPrivateAuth`), falling back to
 * `'dev-secret-change-in-production'`. Sign the suite's tokens with the secret
 * the app is actually configured with, so these cases exercise the real auth
 * guard instead of tripping it with a signature mismatch. The guard itself is
 * untouched.
 */
process.env['JWT_SECRET'] = JWT_SECRET;

const TEST_AI_ENV: AiEnv = {
  driver: 'mock',
  modelId: 'mock-fixture-v1',
  schemaRepairMaxAttempts: 1,
  tokenEstimateFallbackChars: 4,
  baseUrl: null,
  apiKeyPresent: false,
  timeoutMs: 30_000,
  maxTokens: 4_096,
  imageEnabled: false,
  imageApiKey: null,
  imageBaseUrl: 'https://api.x.ai/v1',
  imageModelId: 'grok-imagine-image',
  hermesApiKey: null,
  hermesBaseUrl: 'https://api.nousresearch.com',
  openaiApiKey: null,
  openaiBaseUrl: 'https://api.openai.com',
  openaiModelId: 'gpt-4o-mini',
  tierModels: { free: null, pro: null, plus: null },
};

/** Deterministic schema-valid question fixture, keyed off the blueprint sequence. */
function registerDeterministicQuestionFixture(): void {
  registerMockFixture('question-generation-v1', (input) => {
    const sequence = Number(input.signals?.['sequence'] ?? 0);
    return {
      ok: true,
      payload: {
        stem: `Soal seam ${sequence}`,
        options: [
          { key: 'A', text: 'Pilihan A' },
          { key: 'B', text: 'Pilihan B' },
        ],
        answer: 'A',
        explanation: `Penjelasan seam ${sequence}.`,
        sourceIds: [],
        imageRecommended: false,
        imagePrompt: '',
        imageAlt: '',
      },
    };
  });
}

interface WorkerSeamOptions {
  assessmentsStore?: AssessmentsStore;
  generationStore: QuestionGenerationStore;
  reviewStore: QuestionReviewStore;
}

/**
 * Build the worker-side generation handler over the given persistence seam,
 * mirroring how `WorkerService.setupHandlers` wires `AssessmentGenerationHandler`.
 */
function buildWorkerHandler(options: WorkerSeamOptions): AssessmentGenerationHandler {
  const reviewService = new QuestionReviewService({ store: options.reviewStore });
  const retrievalService = new SourceRetrievalService({
    retrievalStore: new InMemorySourceRetrievalStore({
      passagesStore: { listPassagesByUpload: async () => [] } as never,
      uploadsStore: {} as never,
    }),
  });
  const blueprintService = new BlueprintPipelineService({
    store: new InMemoryBlueprintPipelineStore(),
    assessmentsStore: (options.assessmentsStore ?? {}) as AssessmentsStore,
    retrievalService,
  });
  const aiService = new ProductAiService({
    adapter: new MockAiAdapter(),
    env: TEST_AI_ENV,
    schemas: new Map([['question-generation-v1', QUESTION_OUTPUT_SCHEMA]]),
    audit: new InMemoryAiAuditRecorder(),
  });
  const questionGenerationService = new QuestionGenerationService({
    store: options.generationStore,
    blueprintService,
    aiService,
    env: TEST_AI_ENV,
  });

  return new AssessmentGenerationHandler({
    questionGenerationService,
    questionReviewService: reviewService,
    ...(options.assessmentsStore ? { assessmentsStore: options.assessmentsStore } : {}),
  });
}

function makeJobContext(input: {
  workspaceId: string;
  actorId: string;
  assessmentId: string;
  assessmentVersionId: string;
  sequences: number[];
}): JobContext {
  return {
    jobId: randomUUID(),
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    attempt: 1,
    payload: {
      assessmentId: input.assessmentId,
      assessmentVersionId: input.assessmentVersionId,
      blueprintItems: input.sequences.map((sequence) => ({
        sequence,
        questionType: 'multiple_choice',
        difficulty: 'medium',
      })),
    },
    signal: new AbortController().signal,
  };
}

function signToken(userId: string, workspaceId: string): string {
  return jwt.sign(
    { userId, email: `${userId}@seam.test`, workspaceId, roles: ['teacher'], sv: 1 },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 + 3. Postgres seam (requires DATABASE_URL)
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)('assessment seam — API and worker share one Postgres database', () => {
  let db: Database;
  let workspaceId: string;
  let userId: string;
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  beforeAll(async () => {
    db = createDatabase({ connectionString: DATABASE_URL! });
  });

  afterAll(async () => {
    await cleanup(db);
    await closeDatabase(db);
  });

  beforeEach(async () => {
    clearMockFixtures();
    registerDeterministicQuestionFixture();
    workspaceId = randomUUID();
    userId = randomUUID();
    const pool = getPool(db)!;
    await pool.query('INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)', [
      workspaceId,
      `seam-${workspaceId.slice(0, 8)}`,
      'Seam Workspace',
    ]);
    await pool.query(
      `INSERT INTO jwt_users (id, email, username, password_hash, name, roles, workspace_id, session_version)
       VALUES ($1, $2, $3, 'x', 'Seam Teacher', ARRAY['teacher']::text[], $4, 1)`,
      [userId, `${userId}@seam.test`, `seam_${userId.slice(0, 8)}`, workspaceId],
    );
  });

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) await app.close();
    }
    clearMockFixtures();
    await cleanup(db);
  });

  /** Remove every row this suite owns, keyed on the workspace it created. */
  async function cleanup(database: Database): Promise<void> {
    const pool = getPool(database);
    if (!pool) return;
    const ownWorkspaces = await pool.query<{ id: string }>(
      "SELECT id FROM tenants WHERE slug LIKE 'seam-%'",
    );
    const ids = ownWorkspaces.rows.map((row) => row.id);
    if (ids.length === 0) return;
    await pool.query(
      `DELETE FROM question_audit_log
        WHERE workspace_id::text = ANY($1::text[])`,
      [ids],
    );
    await pool.query(`DELETE FROM reviewed_questions WHERE workspace_id::text = ANY($1::text[])`, [
      ids,
    ]);
    // generated_questions.workspace_id is `text` on this branch while the other
    // assessment tables are `uuid`; compare as text so the cleanup is correct
    // either way (see the migration-journal hotspot noted in worklog).
    await pool.query(`DELETE FROM generated_questions WHERE workspace_id::text = ANY($1::text[])`, [
      ids,
    ]);
    await pool.query(
      `DELETE FROM blueprint_items
        WHERE assessment_version_id::text IN (
          SELECT id::text FROM assessment_versions WHERE workspace_id::text = ANY($1::text[])
        )`,
      [ids],
    );
    await pool.query(`DELETE FROM assessment_versions WHERE workspace_id::text = ANY($1::text[])`, [
      ids,
    ]);
    await pool.query(`DELETE FROM assessments WHERE workspace_id::text = ANY($1::text[])`, [ids]);
    await pool.query(`DELETE FROM spike_idempotency_keys WHERE workspace_id = ANY($1::text[])`, [
      ids,
    ]);
    await pool.query(`DELETE FROM spike_jobs WHERE workspace_id = ANY($1::text[])`, [ids]);
    await pool.query(`DELETE FROM jwt_users WHERE workspace_id::text = ANY($1::text[])`, [ids]);
    await pool.query(`DELETE FROM tenants WHERE id::text = ANY($1::text[])`, [ids]);
  }

  async function buildApiApp(): Promise<Awaited<ReturnType<typeof buildApp>>> {
    const app = await buildApp({ logger: false });
    apps.push(app);
    return app;
  }

  async function seedAssessment(input: {
    title: string;
  }): Promise<{ assessmentId: string; versionId: string }> {
    const pool = getPool(db)!;
    const assessmentId = randomUUID();
    const versionId = randomUUID();
    await pool.query(
      `INSERT INTO assessments (id, workspace_id, creator_user_id, title, status, current_version)
       VALUES ($1, $2, $3, $4, 'generating', 1)`,
      [assessmentId, workspaceId, userId, input.title],
    );
    await pool.query(
      `INSERT INTO assessment_versions (id, assessment_id, workspace_id, version, status, config_snapshot, schema_version)
       VALUES ($1, $2, $3, 1, 'generating', '{}'::jsonb, '1')`,
      [versionId, assessmentId, workspaceId],
    );
    return { assessmentId, versionId };
  }

  it('worker-written generated + reviewed rows are read back by a separately built API process', async () => {
    const { assessmentId, versionId } = await seedAssessment({ title: 'Seam Roundtrip' });
    const pool = getPool(db)!;

    // Worker side: Postgres-backed stores, as WorkerService wires them.
    const handler = buildWorkerHandler({
      assessmentsStore: new PostgresAssessmentsStore(db),
      generationStore: new PostgresQuestionGenerationStore(pool),
      reviewStore: new PostgresQuestionReviewStore(db),
    });

    const result = await handler.handle(
      makeJobContext({
        workspaceId,
        actorId: userId,
        assessmentId,
        assessmentVersionId: versionId,
        sequences: [0, 1, 2],
      }),
    );
    expect(result.status).toBe('success');

    // Read-after-write straight through the database, independent of the worker's handles.
    const generated = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM generated_questions WHERE workspace_id = $1 AND assessment_version_id = $2',
      [workspaceId, versionId],
    );
    const reviewed = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM reviewed_questions WHERE workspace_id = $1 AND assessment_version_id = $2',
      [workspaceId, versionId],
    );
    expect(generated.rows[0]?.n).toBe(3);
    expect(reviewed.rows[0]?.n).toBe(3);

    // API side: a freshly constructed app process must see the worker's rows.
    const app = await buildApiApp();
    const token = signToken(userId, workspaceId);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/assessments/${assessmentId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().assessment.status).toBe('ready');

    const reviewList = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/assessments/${assessmentId}/versions/${versionId}/questions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reviewList.statusCode).toBe(200);
    const questions = reviewList.json().data.questions as Array<{
      originalQuestionId: string;
      blueprintSequence: number;
      status: string;
    }>;
    expect(questions).toHaveLength(3);
    expect(questions.map((q) => q.blueprintSequence).sort()).toEqual([0, 1, 2]);
    expect(questions.every((q) => q.status === 'pending')).toBe(true);

    // The reviewed rows must point back at the persisted generated rows.
    const generatedIds = await pool.query<{ id: string }>(
      'SELECT id FROM generated_questions WHERE workspace_id = $1 AND assessment_version_id = $2',
      [workspaceId, versionId],
    );
    expect(questions.map((q) => q.originalQuestionId).sort()).toEqual(
      generatedIds.rows.map((row) => row.id).sort(),
    );
  });

  it('imports one review row per persisted question and does not duplicate on job replay', async () => {
    const { assessmentId, versionId } = await seedAssessment({ title: 'Seam Import Pass' });
    const pool = getPool(db)!;
    const handler = buildWorkerHandler({
      assessmentsStore: new PostgresAssessmentsStore(db),
      generationStore: new PostgresQuestionGenerationStore(pool),
      reviewStore: new PostgresQuestionReviewStore(db),
    });
    const context = makeJobContext({
      workspaceId,
      actorId: userId,
      assessmentId,
      assessmentVersionId: versionId,
      sequences: [0, 1],
    });

    const first = await handler.handle(context);
    expect(first.status).toBe('success');

    const createdAudit = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM question_audit_log
        WHERE workspace_id = $1 AND action = 'created'`,
      [workspaceId],
    );
    expect(createdAudit.rows[0]?.n).toBe(2);

    // Replaying the same job (queue redelivery) must not add review rows.
    const replay = await handler.handle(context);
    expect(replay.status).toBe('success');
    const reviewedAfterReplay = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM reviewed_questions WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(reviewedAfterReplay.rows[0]?.n).toBe(2);
    const generatedAfterReplay = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM generated_questions WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(generatedAfterReplay.rows[0]?.n).toBe(2);
  });

  it('a job submitted through the API queue store is claimable by an independently built worker store', async () => {
    // Two separate calls model the two processes: neither shares an in-process object.
    const apiStore = createSharedQueueStore(process.env);
    const workerStore = createSharedQueueStore(process.env);
    expect(apiStore).toBeInstanceOf(PostgresQueueStore);
    expect(workerStore).toBeInstanceOf(PostgresQueueStore);
    expect(apiStore).not.toBe(workerStore);

    const jobId = apiStore.newId();
    await apiStore.insertJob({
      id: jobId,
      workspaceId,
      actorId: userId,
      kind: 'assessment_generation',
      status: 'queued',
      attempt: 0,
      maxAttempts: 3,
      leaseTtlMs: 30_000,
      leaseExpiresAt: null,
      heartbeatAt: null,
      payload: { assessmentVersionId: 'seam-queue-version' },
      quotaUnits: 1,
      nextAttemptAt: null,
      lastError: null,
    });

    // The worker process reads the same row without any shared memory.
    const claimed = await workerStore.getJob(jobId);
    expect(claimed).not.toBeNull();
    expect(claimed?.workspaceId).toBe(workspaceId);
    expect(claimed?.payload).toEqual({ assessmentVersionId: 'seam-queue-version' });
    expect(claimed?.status).toBe('queued');

    const reserved = await workerStore.reserveClaim(jobId, 'seam-worker', new Date(), 5_000);
    expect(reserved?.status).toBe('running');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. In-memory fallback (no DATABASE_URL)
// ─────────────────────────────────────────────────────────────────────────────

describe('assessment seam — in-memory fallback without DATABASE_URL', () => {
  let savedDatabaseUrl: string | undefined;
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  beforeEach(() => {
    savedDatabaseUrl = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    clearMockFixtures();
    registerDeterministicQuestionFixture();
  });

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) await app.close();
    }
    if (savedDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = savedDatabaseUrl;
    clearMockFixtures();
  });

  it('resolves the queue store to the in-memory adapter when DATABASE_URL is absent', () => {
    expect(createSharedQueueStore(process.env)).toBeInstanceOf(InMemoryQueueStore);
  });

  it('serves the assessment create + list roundtrip without a database', async () => {
    const app = await buildApp({ logger: false });
    apps.push(app);
    const workspaceId = randomUUID();
    const token = signToken(randomUUID(), workspaceId);

    const created = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/assessments`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'Fallback Ulangan',
        curriculumVersionId: 'cur-1',
        gradeId: 'grade-7',
        subjectId: 'MTK',
        sourceUploadIds: [],
        blueprintItems: [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const assessmentId = created.json().assessment.id as string;

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/assessments`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().assessments.map((a: { id: string }) => a.id)).toContain(assessmentId);
  });

  it("keeps fallback state process-local: a second app process does not see the first one's rows", async () => {
    const workspaceId = randomUUID();
    const token = signToken(randomUUID(), workspaceId);

    const firstApp = await buildApp({ logger: false });
    apps.push(firstApp);
    const created = await firstApp.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/assessments`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'Fallback Isolation',
        curriculumVersionId: 'cur-1',
        gradeId: 'grade-7',
        subjectId: 'MTK',
        sourceUploadIds: [],
        blueprintItems: [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      },
    });
    expect(created.statusCode).toBe(201);

    // A separately constructed process has its own in-memory store — exactly the
    // divergence the Postgres seam exists to remove.
    const secondApp = await buildApp({ logger: false });
    apps.push(secondApp);
    const listed = await secondApp.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/assessments`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().assessments).toHaveLength(0);
  });

  it('runs the worker generation/import roundtrip against in-memory stores', async () => {
    const workspaceId = randomUUID();
    const assessmentVersionId = randomUUID();
    const reviewStore = new InMemoryQuestionReviewStore();
    const handler = buildWorkerHandler({
      generationStore: new InMemoryQuestionGenerationStore(),
      reviewStore,
    });

    const result = await handler.handle(
      makeJobContext({
        workspaceId,
        actorId: randomUUID(),
        assessmentId: randomUUID(),
        assessmentVersionId,
        sequences: [0, 1],
      }),
    );
    expect(result.status).toBe('success');

    const reviewed = await reviewStore.listByAssessmentVersion(workspaceId, assessmentVersionId);
    expect(reviewed).toHaveLength(2);
    expect(reviewed.map((q) => q.blueprintSequence).sort()).toEqual([0, 1]);
    expect(reviewed.every((q) => q.status === 'pending')).toBe(true);
  });
});
