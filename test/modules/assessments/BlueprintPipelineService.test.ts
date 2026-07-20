/**
 * B3-02 — Unit tests for BlueprintPipelineService.
 *
 * Tests cover:
 * - Schema validation (valid, invalid question type, invalid difficulty, etc.)
 * - Coverage enforcement (distribution, source coverage)
 * - Insufficient-source behavior (propagates InsufficientSourceError)
 * - Cached snapshot return (idempotent builds)
 * - Tenant isolation
 */
import { describe, it, expect } from 'vitest';

import { BlueprintPipelineService } from '../../../src/modules/assessments/application/BlueprintPipelineService.js';
import { InMemoryBlueprintPipelineStore } from '../../../src/modules/assessments/persistence/InMemoryBlueprintPipelineStore.js';
import { InMemoryAssessmentsStore } from '../../../src/modules/assessments/persistence/InMemoryAssessmentsStore.js';
import { InMemorySourcePassagesStore } from '../../../src/modules/sources/persistence/InMemorySourceExtractionStores.js';
import { InMemorySourceUploadsStore } from '../../../src/modules/uploads/persistence/InMemorySourceUploadsStore.js';
import { InMemorySourceRetrievalStore } from '../../../src/modules/sources/persistence/InMemorySourceRetrievalStore.js';
import { SourceRetrievalService } from '../../../src/modules/sources/application/SourceRetrievalService.js';
import { ApiError } from '../../../src/common/errors/envelope.js';
import type {
  CoverageTargets,
  BlueprintSnapshotItem,
} from '../../../src/modules/assessments/domain/BlueprintPipeline.js';

// ---- Test fixtures ----

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_WORKSPACE = '00000000-0000-0000-0000-000000000002';
const CREATOR_ID = '00000000-0000-0000-0000-000000000003';
const CURRICULUM_VERSION_ID = 'curriculum-v1';
const GRADE_ID = 'grade-7';
const SUBJECT_ID = 'subject-math';
const UPLOAD_ID_1 = '00000000-0000-0000-0000-000000000010';
const UPLOAD_ID_2 = '00000000-0000-0000-0000-000000000011';
const JOB_ID = '00000000-0000-0000-0000-000000000030';

const DEFAULT_COVERAGE: CoverageTargets = {
  minTotalItems: 1,
  maxTotalItems: 100,
  difficultyDistribution: { easy: 0.2, medium: 0.5, hard: 0.3 },
  questionTypeDistribution: {
    multiple_choice: 0.4,
    short_answer: 0.3,
    essay: 0.2,
    true_false: 0.1,
  },
  minSourceCoverage: 0.5,
};

// ---- Helpers ----

function makeService() {
  const pipelineStore = new InMemoryBlueprintPipelineStore();
  const assessmentsStore = new InMemoryAssessmentsStore();
  const passagesStore = new InMemorySourcePassagesStore();
  const uploadsStore = new InMemorySourceUploadsStore();
  const retrievalStore = new InMemorySourceRetrievalStore({ passagesStore, uploadsStore });
  const retrievalService = new SourceRetrievalService({ retrievalStore });
  const service = new BlueprintPipelineService({
    store: pipelineStore,
    assessmentsStore,
    retrievalService,
  });
  return { service, pipelineStore, assessmentsStore, passagesStore, uploadsStore, retrievalStore };
}

async function seedUpload(
  uploadsStore: InMemorySourceUploadsStore,
  uploadId: string,
  workspaceId: string,
) {
  await uploadsStore.insertUpload({
    id: uploadId,
    tenantId: 'tenant-1',
    workspaceId,
    uploaderUserId: CREATOR_ID,
    filenameRedacted: '[redacted]',
    contentType: 'application/pdf',
    byteSize: 1024,
    status: 'verified',
  });
  await uploadsStore.insertVersion({
    uploadId,
    version: 1,
    storageDriver: 'memory',
    storageKey: `key/${uploadId}.pdf`,
    contentHash: 'abc123',
    redactionClassification: 'user_private',
  });
}

async function seedPassages(
  passagesStore: InMemorySourcePassagesStore,
  uploadId: string,
  workspaceId: string,
  texts: string[],
) {
  for (let i = 0; i < texts.length; i++) {
    await passagesStore.insertPassage({
      uploadId,
      workspaceId,
      extractionJobId: JOB_ID,
      pageNumber: 1,
      sequence: i,
      textNormalized: texts[i]!,
      contentHash: `hash-${uploadId}-${i}`,
      parserVersion: '1.0.0',
    });
  }
}

async function createAssessmentVersion(
  assessmentsStore: InMemoryAssessmentsStore,
  sourceUploadIds: string[] = [],
  blueprintItems: Array<{
    sequence: number;
    questionType: string;
    difficulty: string;
    sourceUploadId?: string;
  }> = [],
) {
  // Create assessment
  const assessment = await assessmentsStore.createAssessment({
    workspaceId: WORKSPACE_ID,
    creatorUserId: CREATOR_ID,
    title: 'Test Assessment',
    idempotencyKey: `idem-${Date.now()}`,
  });

  // Create version with config snapshot
  const version = await assessmentsStore.createAssessmentVersion({
    assessmentId: assessment.id,
    workspaceId: WORKSPACE_ID,
    version: 1,
    configSnapshot: {
      schemaVersion: '1',
      title: 'Test Assessment',
      curriculumVersionId: CURRICULUM_VERSION_ID,
      gradeId: GRADE_ID,
      subjectId: SUBJECT_ID,
      sourceUploadIds,
      blueprintItems: blueprintItems.map((item) => ({
        sequence: item.sequence,
        questionType: item.questionType as
          'multiple_choice' | 'short_answer' | 'essay' | 'true_false',
        difficulty: item.difficulty as 'easy' | 'medium' | 'hard',
        outcomeId: null,
        cognitiveLevel: null,
        topicHint: null,
        sourceUploadId: item.sourceUploadId ?? null,
      })),
    },
  });

  // Update assessment with current version
  await assessmentsStore.updateAssessment({
    id: assessment.id,
    workspaceId: WORKSPACE_ID,
    currentVersion: 1,
  });

  return version;
}

// ---- Tests ----

describe('BlueprintPipelineService', () => {
  describe('buildBlueprint — schema validation', () => {
    it('builds a valid blueprint with correct schema', async () => {
      const { service, assessmentsStore, passagesStore, uploadsStore } = makeService();
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);
      await seedPassages(passagesStore, UPLOAD_ID_1, WORKSPACE_ID, ['Passage text']);

      const version = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1],
        [
          {
            sequence: 0,
            questionType: 'multiple_choice',
            difficulty: 'medium',
            sourceUploadId: UPLOAD_ID_1,
          },
          {
            sequence: 1,
            questionType: 'short_answer',
            difficulty: 'easy',
            sourceUploadId: UPLOAD_ID_1,
          },
        ],
      );

      const result = await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: version.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: {
          ...DEFAULT_COVERAGE,
          minSourceCoverage: 0,
          difficultyDistribution: {},
          questionTypeDistribution: {},
        },
        requestId: 'req-1',
      });

      expect(result.snapshot).toBeDefined();
      expect(result.snapshot.items).toHaveLength(2);
      expect(result.snapshot.items[0]!.sequence).toBe(0);
      expect(result.snapshot.items[0]!.questionType).toBe('multiple_choice');
      expect(result.snapshot.items[1]!.sequence).toBe(1);
      expect(result.snapshot.items[1]!.questionType).toBe('short_answer');
      expect(result.validation.valid).toBe(true);
      expect(result.cached).toBe(false);
    });

    it('rejects invalid question type', async () => {
      const { service, assessmentsStore, passagesStore, uploadsStore } = makeService();
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);
      await seedPassages(passagesStore, UPLOAD_ID_1, WORKSPACE_ID, ['Passage text']);

      const version = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1],
        [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { sequence: 0, questionType: 'fill_blank', difficulty: 'medium' } as any,
        ],
      );

      const result = await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: version.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: DEFAULT_COVERAGE,
        requestId: 'req-1',
      });

      expect(result.validation.valid).toBe(false);
      expect(result.validation.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'invalid_question_type' })]),
      );
    });

    it('rejects invalid difficulty level', async () => {
      const { service, assessmentsStore, passagesStore, uploadsStore } = makeService();
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);
      await seedPassages(passagesStore, UPLOAD_ID_1, WORKSPACE_ID, ['Passage text']);

      const version = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1],
        [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { sequence: 0, questionType: 'multiple_choice', difficulty: 'extreme' } as any,
        ],
      );

      const result = await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: version.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: DEFAULT_COVERAGE,
        requestId: 'req-1',
      });

      expect(result.validation.valid).toBe(false);
      expect(result.validation.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'invalid_difficulty' })]),
      );
    });

    it('rejects duplicate sequences', async () => {
      const { service, assessmentsStore, passagesStore, uploadsStore } = makeService();
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);
      await seedPassages(passagesStore, UPLOAD_ID_1, WORKSPACE_ID, ['Passage text']);

      const version = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1],
        [
          { sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' },
          { sequence: 0, questionType: 'short_answer', difficulty: 'easy' },
        ],
      );

      const result = await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: version.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: DEFAULT_COVERAGE,
        requestId: 'req-1',
      });

      expect(result.validation.valid).toBe(false);
      expect(result.validation.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'duplicate_sequence' })]),
      );
    });

    it('rejects schema version that does not exist', async () => {
      const { service, assessmentsStore } = makeService();

      const version = await createAssessmentVersion(
        assessmentsStore,
        [],
        [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      );

      await expect(
        service.buildBlueprint({
          workspaceId: WORKSPACE_ID,
          assessmentVersionId: version.id,
          blueprintSchemaVersion: '99.99.99',
          coverageTargets: DEFAULT_COVERAGE,
          requestId: 'req-1',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('buildBlueprint — coverage enforcement', () => {
    it('rejects total items below minimum', async () => {
      const { service, assessmentsStore, passagesStore, uploadsStore } = makeService();
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);
      await seedPassages(passagesStore, UPLOAD_ID_1, WORKSPACE_ID, ['Passage text']);

      const version = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1],
        [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      );

      const result = await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: version.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { ...DEFAULT_COVERAGE, minTotalItems: 3 },
        requestId: 'req-1',
      });

      expect(result.validation.valid).toBe(false);
      expect(result.validation.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'total_items_below_min' })]),
      );
    });

    it('rejects total items above maximum', async () => {
      const { service, assessmentsStore, passagesStore, uploadsStore } = makeService();
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);
      await seedPassages(passagesStore, UPLOAD_ID_1, WORKSPACE_ID, ['Passage text']);

      const version = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1],
        [
          { sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' },
          { sequence: 1, questionType: 'short_answer', difficulty: 'easy' },
        ],
      );

      const result = await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: version.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { ...DEFAULT_COVERAGE, maxTotalItems: 1 },
        requestId: 'req-1',
      });

      expect(result.validation.valid).toBe(false);
      expect(result.validation.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'total_items_above_max' })]),
      );
    });

    it('rejects difficulty distribution mismatch', async () => {
      const { service, assessmentsStore, passagesStore, uploadsStore } = makeService();
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);
      await seedPassages(passagesStore, UPLOAD_ID_1, WORKSPACE_ID, ['Passage text']);

      const version = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1],
        [
          { sequence: 0, questionType: 'multiple_choice', difficulty: 'easy' },
          { sequence: 1, questionType: 'short_answer', difficulty: 'easy' },
          { sequence: 2, questionType: 'essay', difficulty: 'easy' },
          { sequence: 3, questionType: 'true_false', difficulty: 'easy' },
          { sequence: 4, questionType: 'multiple_choice', difficulty: 'easy' },
        ],
      );

      const result = await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: version.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: {
          ...DEFAULT_COVERAGE,
          difficultyDistribution: { easy: 0.2, medium: 0.5, hard: 0.3 },
        },
        requestId: 'req-1',
      });

      expect(result.validation.valid).toBe(false);
      expect(result.validation.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'difficulty_distribution_mismatch' }),
        ]),
      );
    });

    it('rejects source coverage below minimum', async () => {
      const { service, assessmentsStore, passagesStore, uploadsStore } = makeService();
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);
      await seedPassages(passagesStore, UPLOAD_ID_1, WORKSPACE_ID, ['Passage text']);

      const version = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1],
        [
          {
            sequence: 0,
            questionType: 'multiple_choice',
            difficulty: 'medium',
            sourceUploadId: UPLOAD_ID_1,
          },
          { sequence: 1, questionType: 'short_answer', difficulty: 'easy' },
          { sequence: 2, questionType: 'essay', difficulty: 'hard' },
        ],
      );

      const result = await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: version.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { ...DEFAULT_COVERAGE, minSourceCoverage: 0.5 },
        requestId: 'req-1',
      });

      expect(result.validation.valid).toBe(false);
      expect(result.validation.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'source_coverage_below_min' })]),
      );
    });

    it('validates coverage on cached snapshots too', async () => {
      const { service, assessmentsStore, passagesStore, uploadsStore } = makeService();
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);
      await seedPassages(passagesStore, UPLOAD_ID_1, WORKSPACE_ID, ['Passage text']);

      const version = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1],
        [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      );

      // First build — succeeds with lenient coverage
      await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: version.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: {
          ...DEFAULT_COVERAGE,
          minTotalItems: 1,
          maxTotalItems: 100,
          minSourceCoverage: 0,
          difficultyDistribution: {},
          questionTypeDistribution: {},
        },
        requestId: 'req-1',
      });

      // Second build — cached but stricter total items fails
      const result = await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: version.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: {
          ...DEFAULT_COVERAGE,
          minTotalItems: 5,
          maxTotalItems: 100,
          minSourceCoverage: 0,
          difficultyDistribution: {},
          questionTypeDistribution: {},
        },
        requestId: 'req-2',
      });

      expect(result.cached).toBe(true);
      expect(result.validation.valid).toBe(false);
      expect(result.validation.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'total_items_below_min' })]),
      );
    });
  });

  describe('buildBlueprint — insufficient source behavior', () => {
    it('propagates InsufficientSourceError as STATE_CONFLICT', async () => {
      const { service, assessmentsStore, uploadsStore } = makeService();
      // Seed upload but do NOT seed passages — retrieval will throw
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);

      const version = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1],
        [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      );

      await expect(
        service.buildBlueprint({
          workspaceId: WORKSPACE_ID,
          assessmentVersionId: version.id,
          blueprintSchemaVersion: '1.0.0',
          coverageTargets: DEFAULT_COVERAGE,
          requestId: 'req-1',
        }),
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    });

    it('returns actionable error message for insufficient sources', async () => {
      const { service, assessmentsStore, uploadsStore } = makeService();
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);

      const version = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1],
        [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      );

      try {
        await service.buildBlueprint({
          workspaceId: WORKSPACE_ID,
          assessmentVersionId: version.id,
          blueprintSchemaVersion: '1.0.0',
          coverageTargets: DEFAULT_COVERAGE,
          requestId: 'req-1',
        });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.message).toContain('Insufficient source');
        expect(apiErr.fieldErrors).toBeDefined();
      }
    });
  });

  describe('buildBlueprint — cached snapshot', () => {
    it('returns cached=true on second build', async () => {
      const { service, assessmentsStore, passagesStore, uploadsStore } = makeService();
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);
      await seedPassages(passagesStore, UPLOAD_ID_1, WORKSPACE_ID, ['Passage text']);

      const version = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1],
        [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      );

      const first = await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: version.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: DEFAULT_COVERAGE,
        requestId: 'req-1',
      });

      const second = await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: version.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: DEFAULT_COVERAGE,
        requestId: 'req-2',
      });

      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      expect(second.snapshot.id).toBe(first.snapshot.id);
    });
  });

  describe('getBlueprint', () => {
    it('returns null when no snapshot exists', async () => {
      const { service } = makeService();

      const result = await service.getBlueprint(WORKSPACE_ID, 'nonexistent-version');
      expect(result).toBeNull();
    });

    it('returns snapshot after build', async () => {
      const { service, assessmentsStore, passagesStore, uploadsStore } = makeService();
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);
      await seedPassages(passagesStore, UPLOAD_ID_1, WORKSPACE_ID, ['Passage text']);

      const version = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1],
        [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      );

      const built = await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: version.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: DEFAULT_COVERAGE,
        requestId: 'req-1',
      });

      const got = await service.getBlueprint(WORKSPACE_ID, version.id);
      expect(got).not.toBeNull();
      expect(got!.id).toBe(built.snapshot.id);
    });

    it('does not cross workspace boundaries', async () => {
      const { service, assessmentsStore, passagesStore, uploadsStore } = makeService();
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);
      await seedPassages(passagesStore, UPLOAD_ID_1, WORKSPACE_ID, ['Passage text']);

      const version = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1],
        [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      );

      await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: version.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: DEFAULT_COVERAGE,
        requestId: 'req-1',
      });

      const result = await service.getBlueprint(OTHER_WORKSPACE, version.id);
      expect(result).toBeNull();
    });
  });

  describe('tenant isolation', () => {
    it('builds independent snapshots per workspace', async () => {
      const { service, assessmentsStore, passagesStore, uploadsStore } = makeService();

      // Seed for workspace A
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);
      await seedPassages(passagesStore, UPLOAD_ID_1, WORKSPACE_ID, ['Passage A']);

      // Seed for workspace B
      await seedUpload(uploadsStore, UPLOAD_ID_2, OTHER_WORKSPACE);
      await seedPassages(passagesStore, UPLOAD_ID_2, OTHER_WORKSPACE, ['Passage B']);

      // Create version in workspace A
      const versionA = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1],
        [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      );

      // Build for workspace A
      await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: versionA.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: DEFAULT_COVERAGE,
        requestId: 'req-1',
      });

      // Workspace B should not see it
      const gotB = await service.getBlueprint(OTHER_WORKSPACE, versionA.id);
      expect(gotB).toBeNull();
    });
  });

  describe('immutability (D-013)', () => {
    it('snapshot items are frozen after creation', async () => {
      const { service, assessmentsStore, passagesStore, uploadsStore } = makeService();
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);
      await seedPassages(passagesStore, UPLOAD_ID_1, WORKSPACE_ID, ['Passage text']);

      const version = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1],
        [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      );

      const result = await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: version.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { ...DEFAULT_COVERAGE, minSourceCoverage: 0 },
        requestId: 'req-1',
      });

      // Verify initial state
      expect(result.snapshot.items).toHaveLength(1);

      // Modify the items array reference
      const items = result.snapshot.items;
      items.push({
        sequence: 99,
        questionType: 'essay',
        difficulty: 'hard',
      } as BlueprintSnapshotItem);

      // Fetch again — should not be affected
      const got = await service.getBlueprint(WORKSPACE_ID, version.id);
      expect(got!.items).toHaveLength(1);
    });
  });

  describe('source evidence', () => {
    it('records source evidence from passages', async () => {
      const { service, assessmentsStore, passagesStore, uploadsStore } = makeService();
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);
      await seedPassages(passagesStore, UPLOAD_ID_1, WORKSPACE_ID, ['Passage 1', 'Passage 2']);

      const version = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1],
        [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      );

      const result = await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: version.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: DEFAULT_COVERAGE,
        requestId: 'req-1',
      });

      expect(result.snapshot.sourceEvidence).toHaveLength(1);
      expect(result.snapshot.sourceEvidence[0]!.uploadId).toBe(UPLOAD_ID_1);
      expect(result.snapshot.sourceEvidence[0]!.passageCount).toBe(2);
    });

    it('handles multiple source uploads', async () => {
      const { service, assessmentsStore, passagesStore, uploadsStore } = makeService();
      await seedUpload(uploadsStore, UPLOAD_ID_1, WORKSPACE_ID);
      await seedUpload(uploadsStore, UPLOAD_ID_2, WORKSPACE_ID);
      await seedPassages(passagesStore, UPLOAD_ID_1, WORKSPACE_ID, ['Passage A']);
      await seedPassages(passagesStore, UPLOAD_ID_2, WORKSPACE_ID, ['Passage B1', 'Passage B2']);

      const version = await createAssessmentVersion(
        assessmentsStore,
        [UPLOAD_ID_1, UPLOAD_ID_2],
        [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      );

      const result = await service.buildBlueprint({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: version.id,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: DEFAULT_COVERAGE,
        requestId: 'req-1',
      });

      expect(result.snapshot.sourceEvidence).toHaveLength(2);
      const evidence1 = result.snapshot.sourceEvidence.find((e) => e.uploadId === UPLOAD_ID_1);
      const evidence2 = result.snapshot.sourceEvidence.find((e) => e.uploadId === UPLOAD_ID_2);
      expect(evidence1!.passageCount).toBe(1);
      expect(evidence2!.passageCount).toBe(2);
    });
  });
});
