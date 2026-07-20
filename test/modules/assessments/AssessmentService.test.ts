/**
 * B2-03 — Unit tests for AssessmentService.
 *
 * Evidence covered:
 * - state-and-contract-tests: happy path, version immutability, blueprint items
 * - incompatible-catalog: source not found, deleted, rejected, not extracted
 * - idempotency: same key + fingerprint returns original; same key + different fingerprint = 409
 * - validation: missing title, missing blueprint items, duplicate sequences
 * - list and get APIs
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { AssessmentService } from '../../../src/modules/assessments/application/AssessmentService.js';
import { InMemoryAssessmentsStore } from '../../../src/modules/assessments/persistence/InMemoryAssessmentsStore.js';
import { InMemorySourceUploadsStore } from '../../../src/modules/uploads/persistence/InMemorySourceUploadsStore.js';
import { InMemorySourceExtractionJobsStore } from '../../../src/modules/sources/persistence/InMemorySourceExtractionStores.js';
import { ApiError } from '../../../src/common/errors/envelope.js';

// ---- constants ----

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const UPLOAD_ID = '00000000-0000-0000-0000-000000000002';
const CREATOR_ID = '00000000-0000-0000-0000-000000000003';
const CURRICULUM_VERSION_ID = 'curriculum-v1';
const GRADE_ID = 'grade-7';
const SUBJECT_ID = 'subject-math';

function makeService(
  overrides: {
    uploadsStore?: InMemorySourceUploadsStore;
    extractionJobsStore?: InMemorySourceExtractionJobsStore;
  } = {},
) {
  const store = new InMemoryAssessmentsStore();
  const uploadsStore = overrides.uploadsStore ?? new InMemorySourceUploadsStore();
  const extractionJobsStore =
    overrides.extractionJobsStore ?? new InMemorySourceExtractionJobsStore();
  const service = new AssessmentService({ store, uploadsStore, extractionJobsStore });
  return { service, store, uploadsStore, extractionJobsStore };
}

const BASE_INPUT = {
  workspaceId: WORKSPACE_ID,
  creatorUserId: CREATOR_ID,
  title: 'Math Assessment Q1',
  curriculumVersionId: CURRICULUM_VERSION_ID,
  gradeId: GRADE_ID,
  subjectId: SUBJECT_ID,
  sourceUploadIds: [] as string[],
  blueprintItems: [
    {
      sequence: 0,
      questionType: 'multiple_choice' as const,
      difficulty: 'medium' as const,
    },
  ],
  requestId: 'req-1',
};

// ---- helper: insert a verified, extracted upload ----

async function insertExtractedUpload(
  uploadsStore: InMemorySourceUploadsStore,
  extractionJobsStore: InMemorySourceExtractionJobsStore,
  uploadId = UPLOAD_ID,
) {
  await uploadsStore.insertUpload({
    id: uploadId,
    tenantId: '00000000-0000-0000-0000-000000000099',
    workspaceId: WORKSPACE_ID,
    uploaderUserId: CREATOR_ID,
    filenameRedacted: '[redacted]',
    contentType: 'application/pdf',
    byteSize: 1024,
    status: 'verified',
  });
  const job = await extractionJobsStore.createJob({
    uploadId,
    workspaceId: WORKSPACE_ID,
  });
  await extractionJobsStore.updateJob({ id: job.id, status: 'succeeded' });
}

// ---- AssessmentService tests ----

describe('AssessmentService', () => {
  describe('createConfig — happy path', () => {
    it('creates assessment, version 1, and blueprint items', async () => {
      const { service } = makeService();

      const result = await service.createConfig(BASE_INPUT);

      expect(result.idempotent).toBe(false);
      expect(result.assessment.title).toBe('Math Assessment Q1');
      expect(result.assessment.workspaceId).toBe(WORKSPACE_ID);
      expect(result.assessment.currentVersion).toBe(1);
      expect(result.assessment.status).toBe('draft');

      expect(result.version.version).toBe(1);
      expect(result.version.assessmentId).toBe(result.assessment.id);
      expect(result.version.configSnapshot.title).toBe('Math Assessment Q1');
      expect(result.version.configSnapshot.curriculumVersionId).toBe(CURRICULUM_VERSION_ID);
      expect(result.version.configSnapshot.blueprintItems).toHaveLength(1);

      expect(result.blueprintItems).toHaveLength(1);
      expect(result.blueprintItems[0]!.sequence).toBe(0);
      expect(result.blueprintItems[0]!.questionType).toBe('multiple_choice');
      expect(result.blueprintItems[0]!.difficulty).toBe('medium');
    });

    it('config snapshot is stored immutably on the version row', async () => {
      const { service, store } = makeService();
      const result = await service.createConfig(BASE_INPUT);

      const stored = await store.getVersionByNumber(
        WORKSPACE_ID,
        result.assessment.id,
        1,
      );
      expect(stored).not.toBeNull();
      expect(stored!.configSnapshot.title).toBe('Math Assessment Q1');
      expect(stored!.configSnapshot.curriculumVersionId).toBe(CURRICULUM_VERSION_ID);
    });

    it('stores sourceUploadIds in the config snapshot', async () => {
      const { service, uploadsStore, extractionJobsStore } = makeService();
      await insertExtractedUpload(uploadsStore, extractionJobsStore);

      const result = await service.createConfig({
        ...BASE_INPUT,
        sourceUploadIds: [UPLOAD_ID],
      });

      expect(result.version.configSnapshot.sourceUploadIds).toContain(UPLOAD_ID);
    });
  });

  describe('createConfig — validation', () => {
    it('rejects empty title', async () => {
      const { service } = makeService();
      await expect(
        service.createConfig({ ...BASE_INPUT, title: '   ' }),
      ).rejects.toThrow(ApiError);
      await expect(
        service.createConfig({ ...BASE_INPUT, title: '   ' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('rejects empty curriculumVersionId', async () => {
      const { service } = makeService();
      await expect(
        service.createConfig({ ...BASE_INPUT, curriculumVersionId: '' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('rejects empty blueprint items array', async () => {
      const { service } = makeService();
      await expect(
        service.createConfig({ ...BASE_INPUT, blueprintItems: [] }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('rejects duplicate blueprint item sequences', async () => {
      const { service } = makeService();
      await expect(
        service.createConfig({
          ...BASE_INPUT,
          blueprintItems: [
            { sequence: 0, questionType: 'multiple_choice', difficulty: 'easy' },
            { sequence: 0, questionType: 'short_answer', difficulty: 'hard' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('createConfig — incompatible catalog / source readiness', () => {
    it('rejects source upload not found in workspace', async () => {
      const { service } = makeService();
      await expect(
        service.createConfig({
          ...BASE_INPUT,
          sourceUploadIds: ['nonexistent-upload-id'],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('rejects deleted source upload', async () => {
      const { service, uploadsStore } = makeService();
      await uploadsStore.insertUpload({
        id: UPLOAD_ID,
        tenantId: '00000000-0000-0000-0000-000000000099',
        workspaceId: WORKSPACE_ID,
        uploaderUserId: CREATOR_ID,
        filenameRedacted: '[redacted]',
        contentType: 'application/pdf',
        byteSize: 1024,
        status: 'deleted',
      });

      await expect(
        service.createConfig({ ...BASE_INPUT, sourceUploadIds: [UPLOAD_ID] }),
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    });

    it('rejects rejected source upload', async () => {
      const { service, uploadsStore } = makeService();
      await uploadsStore.insertUpload({
        id: UPLOAD_ID,
        tenantId: '00000000-0000-0000-0000-000000000099',
        workspaceId: WORKSPACE_ID,
        uploaderUserId: CREATOR_ID,
        filenameRedacted: '[redacted]',
        contentType: 'application/pdf',
        byteSize: 1024,
        status: 'rejected',
      });

      await expect(
        service.createConfig({ ...BASE_INPUT, sourceUploadIds: [UPLOAD_ID] }),
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    });

    it('rejects source upload that has not been extracted yet', async () => {
      const { service, uploadsStore } = makeService();
      await uploadsStore.insertUpload({
        id: UPLOAD_ID,
        tenantId: '00000000-0000-0000-0000-000000000099',
        workspaceId: WORKSPACE_ID,
        uploaderUserId: CREATOR_ID,
        filenameRedacted: '[redacted]',
        contentType: 'application/pdf',
        byteSize: 1024,
        status: 'verified',
      });
      // No extraction job created — source not extracted yet.

      await expect(
        service.createConfig({ ...BASE_INPUT, sourceUploadIds: [UPLOAD_ID] }),
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    });

    it('rejects source upload with failed extraction job', async () => {
      const { service, uploadsStore, extractionJobsStore } = makeService();
      await uploadsStore.insertUpload({
        id: UPLOAD_ID,
        tenantId: '00000000-0000-0000-0000-000000000099',
        workspaceId: WORKSPACE_ID,
        uploaderUserId: CREATOR_ID,
        filenameRedacted: '[redacted]',
        contentType: 'application/pdf',
        byteSize: 1024,
        status: 'verified',
      });
      const job = await extractionJobsStore.createJob({ uploadId: UPLOAD_ID, workspaceId: WORKSPACE_ID });
      await extractionJobsStore.updateJob({ id: job.id, status: 'failed' });

      await expect(
        service.createConfig({ ...BASE_INPUT, sourceUploadIds: [UPLOAD_ID] }),
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    });

    it('accepts source upload with succeeded extraction job', async () => {
      const { service, uploadsStore, extractionJobsStore } = makeService();
      await insertExtractedUpload(uploadsStore, extractionJobsStore);

      const result = await service.createConfig({
        ...BASE_INPUT,
        sourceUploadIds: [UPLOAD_ID],
      });
      expect(result.assessment.status).toBe('draft');
    });
  });

  describe('idempotency', () => {
    it('returns same result for same key + same fingerprint', async () => {
      const { service } = makeService();
      const inputWithKey = { ...BASE_INPUT, idempotencyKey: 'idem-key-1' };

      const first = await service.createConfig(inputWithKey);
      const second = await service.createConfig(inputWithKey);

      expect(second.idempotent).toBe(true);
      expect(second.assessment.id).toBe(first.assessment.id);
      expect(second.version.id).toBe(first.version.id);
    });

    it('returns 409 for same key + different fingerprint', async () => {
      const { service } = makeService();

      await service.createConfig({
        ...BASE_INPUT,
        idempotencyKey: 'idem-key-1',
        title: 'Original Title',
      });

      await expect(
        service.createConfig({
          ...BASE_INPUT,
          idempotencyKey: 'idem-key-1',
          title: 'Different Title',
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    });

    it('allows different keys for different requests', async () => {
      const { service } = makeService();

      const first = await service.createConfig({
        ...BASE_INPUT,
        idempotencyKey: 'key-A',
        title: 'Assessment A',
      });
      const second = await service.createConfig({
        ...BASE_INPUT,
        idempotencyKey: 'key-B',
        title: 'Assessment B',
      });

      expect(second.assessment.id).not.toBe(first.assessment.id);
    });
  });

  describe('getAssessment', () => {
    it('returns assessment with version and blueprint items', async () => {
      const { service } = makeService();
      const created = await service.createConfig(BASE_INPUT);

      const got = await service.getAssessment(WORKSPACE_ID, created.assessment.id, 'req-2');
      expect(got.assessment.id).toBe(created.assessment.id);
      expect(got.version?.version).toBe(1);
      expect(got.blueprintItems).toHaveLength(1);
    });

    it('throws RESOURCE_NOT_FOUND for unknown assessment', async () => {
      const { service } = makeService();
      await expect(
        service.getAssessment(WORKSPACE_ID, 'nonexistent-id', 'req-2'),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('does not cross workspace boundaries', async () => {
      const { service } = makeService();
      const created = await service.createConfig(BASE_INPUT);

      await expect(
        service.getAssessment('other-workspace', created.assessment.id, 'req-2'),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });
  });

  describe('listAssessments', () => {
    it('returns assessments for workspace', async () => {
      const { service } = makeService();
      await service.createConfig({ ...BASE_INPUT, title: 'A1' });
      await service.createConfig({ ...BASE_INPUT, title: 'A2' });

      const list = await service.listAssessments(WORKSPACE_ID, { limit: 10 });
      expect(list).toHaveLength(2);
    });

    it('respects limit', async () => {
      const { service } = makeService();
      for (let i = 0; i < 5; i++) {
        await service.createConfig({ ...BASE_INPUT, title: `Assessment ${i}` });
      }
      const list = await service.listAssessments(WORKSPACE_ID, { limit: 3 });
      expect(list).toHaveLength(3);
    });

    it('returns empty array for workspace with no assessments', async () => {
      const { service } = makeService();
      const list = await service.listAssessments('empty-workspace', { limit: 10 });
      expect(list).toHaveLength(0);
    });
  });
});
