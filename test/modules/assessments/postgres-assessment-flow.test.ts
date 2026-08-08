import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  createDatabase,
  getPool,
  type Database,
} from '../../../src/infrastructure/database/db.js';
import {
  computeEtag,
  QuestionReviewService,
} from '../../../src/modules/assessments/application/QuestionReviewService.js';
import type {
  AssessmentConfigSnapshot,
  BlueprintItemConfig,
} from '../../../src/modules/assessments/domain/Assessment.js';
import type { GeneratedQuestion } from '../../../src/modules/assessments/domain/QuestionGeneration.js';
import type { ReviewedQuestion } from '../../../src/modules/assessments/domain/QuestionReview.js';
import { PostgresAssessmentsStore } from '../../../src/modules/assessments/persistence/PostgresAssessmentsStore.js';
import { PostgresQuestionGenerationStore } from '../../../src/modules/assessments/persistence/PostgresQuestionGenerationStore.js';
import { PostgresQuestionReviewStore } from '../../../src/modules/assessments/persistence/PostgresQuestionReviewStore.js';

const HAS_DB = Boolean(process.env['DATABASE_URL']);
const describeDb = HAS_DB ? describe : describe.skip;

const workspaceId = '11111111-1111-4111-8111-111111111111';
const otherWorkspaceId = '22222222-2222-4222-8222-222222222222';

describeDb('Postgres-backed assessment flow', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase({ connectionString: process.env['DATABASE_URL']! });
    await cleanup(db);
  });

  afterAll(async () => {
    await cleanup(db);
    await closeDatabase(db);
  });

  it('round-trips assessments → versions → blueprint → generated → review across stores', async () => {
    const assessments = new PostgresAssessmentsStore(db);
    const generatedStore = new PostgresQuestionGenerationStore(getPool(db)!);
    const reviewStore = new PostgresQuestionReviewStore(db);

    const actor = randomUUID();
    const creator = randomUUID();
    const assessment = await assessments.createAssessment({
      workspaceId,
      creatorUserId: creator,
      title: 'Ulangan Harian',
    });
    expect(assessment.status).toBe('draft');

    const config: AssessmentConfigSnapshot = {
      schemaVersion: '1',
      title: assessment.title,
      curriculumVersionId: 'curriculum-v1',
      gradeId: 'grade-1',
      subjectId: 'subject-1',
      sourceUploadIds: ['upload-1'],
      blueprintItems: [] as BlueprintItemConfig[],
    };
    const version = await assessments.createAssessmentVersion({
      assessmentId: assessment.id,
      workspaceId,
      version: 1,
      configSnapshot: config,
    });

    await assessments.updateAssessment({
      id: assessment.id,
      workspaceId,
      status: 'generating',
      currentVersion: 1,
    });

    const items = await assessments.createBlueprintItems([
      {
        assessmentVersionId: version.id,
        workspaceId,
        sequence: 0,
        questionType: 'multiple_choice',
        difficulty: 'easy',
      },
      {
        assessmentVersionId: version.id,
        workspaceId,
        sequence: 1,
        questionType: 'short_answer',
        difficulty: 'medium',
      },
    ]);
    expect(items).toHaveLength(2);

    const questions: GeneratedQuestion[] = [
      buildGeneratedQuestion({
        id: randomUUID(),
        workspaceId,
        assessmentVersionId: version.id,
        sequence: 0,
      }),
      buildGeneratedQuestion({
        id: randomUUID(),
        workspaceId,
        assessmentVersionId: version.id,
        sequence: 1,
      }),
    ];

    const saved = await generatedStore.saveQuestions(questions);
    expect(saved).toHaveLength(2);

    const reloaded = await generatedStore.getQuestionsByAssessmentVersionId(workspaceId, version.id);
    expect(reloaded.map((q) => q.blueprintSequence).sort()).toEqual([0, 1]);

    const latestVersion = await assessments.getLatestVersion(workspaceId, assessment.id);
    expect(latestVersion?.id).toBe(version.id);

    const blueprint = await assessments.listBlueprintItems(workspaceId, version.id);
    expect(blueprint).toHaveLength(2);

    const reviewed = await Promise.all(reloaded.map((q) => importAndTouch(reviewStore, q, actor)));
    const listed = await reviewStore.listByAssessmentVersion(workspaceId, version.id);
    expect(listed.map((q) => q.originalQuestionId).sort()).toEqual(
      reviewed.map((q) => q.originalQuestionId).sort(),
    );

    const otherAssessment = await assessments.createAssessment({
      workspaceId: otherWorkspaceId,
      creatorUserId: creator,
      title: 'Other',
    });
    await assessments.createAssessmentVersion({
      assessmentId: otherAssessment.id,
      workspaceId: otherWorkspaceId,
      version: 1,
      configSnapshot: { ...config },
    });
    const ownHistory = await assessments.listAssessments(workspaceId, { limit: 10 });
    const otherHistory = await assessments.listAssessments(otherWorkspaceId, { limit: 10 });
    expect(ownHistory.map((a) => a.id)).not.toContain(otherAssessment.id);
    expect(otherHistory[0]?.id).toBe(otherAssessment.id);
  });

  it('importQuestion is idempotent for the same original question id', async () => {
    const reviewStore = new PostgresQuestionReviewStore(db);
    const service = new QuestionReviewService({ store: reviewStore });
    const generated = buildGeneratedQuestion({
      id: randomUUID(),
      workspaceId,
      assessmentVersionId: randomUUID(),
      sequence: 3,
    });

    const first = await service.importQuestion(generated, randomUUID());
    const second = await service.importQuestion(generated, randomUUID());
    expect(second.id).toBe(first.id);
    expect(second.originalQuestionId).toBe(generated.id);
  });

  it('rejects cross-workspace reads on the review store', async () => {
    const reviewStore = new PostgresQuestionReviewStore(db);
    const generated = buildGeneratedQuestion({
      id: randomUUID(),
      workspaceId,
      assessmentVersionId: randomUUID(),
      sequence: 4,
    });
    const reviewed = await importAndTouch(reviewStore, generated, randomUUID());
    const foreign = await reviewStore.findById(otherWorkspaceId, reviewed.id);
    expect(foreign).toBeNull();
  });
});

async function cleanup(db: Database): Promise<void> {
  const pool = getPool(db);
  if (!pool) return;
  await pool.query(`DELETE FROM question_audit_log WHERE workspace_id IN ($1::uuid, $2::uuid)`, [
    workspaceId,
    otherWorkspaceId,
  ]);
  await pool.query(`DELETE FROM assessment_finalization WHERE workspace_id IN ($1::uuid, $2::uuid)`, [
    workspaceId,
    otherWorkspaceId,
  ]);
  await pool.query(`DELETE FROM reviewed_questions WHERE workspace_id IN ($1::uuid, $2::uuid)`, [
    workspaceId,
    otherWorkspaceId,
  ]);
  await pool.query(`DELETE FROM generated_questions WHERE workspace_id IN ($1, $2)`, [
    workspaceId,
    otherWorkspaceId,
  ]);
  await pool.query(`DELETE FROM blueprint_items WHERE workspace_id IN ($1::uuid, $2::uuid)`, [
    workspaceId,
    otherWorkspaceId,
  ]);
  await pool.query(`DELETE FROM assessment_versions WHERE workspace_id IN ($1::uuid, $2::uuid)`, [
    workspaceId,
    otherWorkspaceId,
  ]);
  await pool.query(`DELETE FROM assessments WHERE workspace_id IN ($1::uuid, $2::uuid)`, [
    workspaceId,
    otherWorkspaceId,
  ]);
}

function buildGeneratedQuestion(input: {
  id: string;
  workspaceId: string;
  assessmentVersionId: string;
  sequence: number;
}): GeneratedQuestion {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    assessmentVersionId: input.assessmentVersionId,
    blueprintSequence: input.sequence,
    questionType: 'multiple_choice',
    difficulty: 'medium',
    stem: `Stem ${input.sequence}`,
    options: [
      { key: 'A', text: 'Pilihan A' },
      { key: 'B', text: 'Pilihan B' },
    ],
    answer: 'A',
    explanation: 'Karena demikian.',
    sourceIds: [`passage-${input.sequence}`],
    versionMetadata: {
      blueprintSchemaVersion: '1.0',
      providerModelId: 'mock-model',
      promptTemplateId: 'question-generation-v1',
      schemaRepairAttempts: 0,
      latencyMs: 12,
    },
    createdAt: new Date().toISOString(),
  };
}

async function importAndTouch(
  store: PostgresQuestionReviewStore,
  question: GeneratedQuestion,
  actor: string,
): Promise<ReviewedQuestion> {
  const service = new QuestionReviewService({ store });
  const reviewed = await service.importQuestion(question, actor);
  const next = await service.editQuestion(
    reviewed.workspaceId,
    reviewed.id,
    { explanation: reviewed.explanation },
    actor,
  );
  expect(next.etag).not.toBe(reviewed.etag);
  expect(computeEtag(reviewed.id, reviewed.version + 1)).toBe(next.etag);
  return next;
}
