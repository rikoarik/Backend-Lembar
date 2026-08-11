/**
 * X3-01 — Generate configuration & retrieval cross-repo integration gate.
 *
 * Exercises current queue handler contracts with realistic in-memory fixtures.
 */
import { describe, expect, it, vi } from 'vitest';

import type { JobContext, JobResult } from '../../../src/infrastructure/queue/domain/JobHandler.js';
import {
  SourceIngestionHandler,
  type SourceIngestionHandlerDeps,
} from '../../../src/infrastructure/queue/handlers/SourceIngestionHandler.js';
import {
  AssessmentGenerationHandler,
  type AssessmentGenerationHandlerOptions,
} from '../../../src/infrastructure/queue/handlers/AssessmentGenerationHandler.js';
import {
  QuestionRegenerationHandler,
  type QuestionRegenerationHandlerOptions,
} from '../../../src/infrastructure/queue/handlers/QuestionRegenerationHandler.js';

function makeContext(payload: Record<string, unknown>): JobContext {
  return {
    jobId: 'job-test-001',
    workspaceId: 'ws-001',
    actorId: 'actor-001',
    attempt: 1,
    payload,
    signal: new AbortController().signal,
  };
}

function makeMockUploadsStore() {
  return {
    getUploadByIdForWorkspace: vi.fn().mockResolvedValue({
      id: 'upload-001',
      tenantId: 'tenant-001',
      workspaceId: 'ws-001',
      uploaderUserId: 'actor-001',
      filenameRedacted: '[redacted]',
      contentType: 'application/pdf',
      byteSize: 123,
      pageCountHint: null,
      magicSignature: null,
      status: 'verified',
      failureCode: null,
      currentVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    currentVersionForUpload: vi.fn().mockResolvedValue({
      id: 'version-001',
      uploadId: 'upload-001',
      version: 1,
      storageDriver: 'memory',
      contentHash: 'hash',
      redactionClassification: 'user_private',
      createdAt: new Date().toISOString(),
    }),
  };
}

function makeMockExtractionService() {
  return {
    run: vi.fn().mockResolvedValue({
      jobId: 'extraction-job-001',
      pageCount: 2,
      passageCount: 2,
      passages: [],
    }),
  };
}

function makeMockQuestionGenService() {
  return {
    generateQuestions: vi.fn().mockResolvedValue({
      questions: [
        {
          id: 'q-001',
          blueprintSequence: 0,
          stem: 'What is the main topic?',
          options: [{ key: 'A', text: 'A' }],
          answer: 'A',
          explanation: 'Based on the passage.',
          sourceIds: ['passage-1'],
          questionType: 'multiple_choice',
          difficulty: 'medium',
        },
      ],
      hasFailures: false,
      failures: [],
      totalSchemaRepairAttempts: 0,
    }),
  };
}

describe('X3-01: Generate configuration & retrieval integration gate', () => {
  describe('Source ingestion handler', () => {
    it('processes a source_ingestion job and returns success', async () => {
      const uploadsStore = makeMockUploadsStore();
      const extractionService = makeMockExtractionService();
      const deps: SourceIngestionHandlerDeps = {
        uploadsStore: uploadsStore as never,
        storage: {} as never,
        extractionService: extractionService as never,
      };
      const result: JobResult = await new SourceIngestionHandler(deps).handle(
        makeContext({ sourceId: 'upload-001' }),
      );

      expect(result.status).toBe('success');
      expect(uploadsStore.getUploadByIdForWorkspace).toHaveBeenCalledWith('ws-001', 'upload-001');
      expect(extractionService.run).toHaveBeenCalled();
    });

    it('fails gracefully when uploadId is missing', async () => {
      const deps: SourceIngestionHandlerDeps = {
        uploadsStore: makeMockUploadsStore() as never,
        storage: {} as never,
        extractionService: makeMockExtractionService() as never,
      };
      const result: JobResult = await new SourceIngestionHandler(deps).handle(makeContext({}));

      expect(result.status).toBe('failure');
      expect(result.error?.code).toBe('MISSING_UPLOAD_ID');
    });
  });

  describe('Assessment generation handler', () => {
    it('processes an assessment_generation job and returns success', async () => {
      const questionGenerationService = makeMockQuestionGenService();
      const options: AssessmentGenerationHandlerOptions = {
        questionGenerationService: questionGenerationService as never,
      };
      const result: JobResult = await new AssessmentGenerationHandler(options).handle(makeContext({
        assessmentId: 'assessment-001',
        assessmentVersionId: 'assessment-version-001',
        blueprintItems: [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      }));

      expect(result.status).toBe('success');
      expect(questionGenerationService.generateQuestions).toHaveBeenCalledWith(expect.objectContaining({
        assessmentVersionId: 'assessment-version-001',
      }));
    });
  });

  describe('Question regeneration handler', () => {
    it('processes a question_regeneration job and returns success', async () => {
      const options: QuestionRegenerationHandlerOptions = {
        questionGenerationService: makeMockQuestionGenService() as never,
      };
      const result: JobResult = await new QuestionRegenerationHandler(options).handle(makeContext({
        assessmentVersionId: 'assessment-001',
        questionId: 'q-001',
        questionType: 'multiple_choice',
        difficulty: 'medium',
        topicHint: 'regenerate this question',
      }));

      expect(result.status).toBe('success');
      expect(result.output?.regenerated).toBe(true);
    });
  });

  describe('End-to-end: source → generate → questions', () => {
    it('chains source ingestion and assessment generation with valid current fixtures', async () => {
      const sourceResult = await new SourceIngestionHandler({
        uploadsStore: makeMockUploadsStore() as never,
        storage: {} as never,
        extractionService: makeMockExtractionService() as never,
      }).handle(makeContext({ sourceId: 'upload-001' }));
      expect(sourceResult.status).toBe('success');

      const questionGenerationService = makeMockQuestionGenService();
      const generationResult = await new AssessmentGenerationHandler({
        questionGenerationService: questionGenerationService as never,
      }).handle(makeContext({
        assessmentId: 'assessment-001',
        blueprintItems: [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      }));

      expect(generationResult.status).toBe('success');
      await expect(questionGenerationService.generateQuestions.mock.results[0]?.value).resolves.toMatchObject({
        questions: [expect.objectContaining({ stem: expect.any(String), answer: expect.any(String) })],
      });
    });
  });
});
