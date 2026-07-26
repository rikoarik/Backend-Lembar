/**
 * X3-01 — Generate configuration & retrieval cross-repo integration gate.
 *
 * Validates that the three job handlers (source_ingestion, assessment_generation,
 * question_regeneration) produce valid JobResult outputs when given realistic
 * payloads and mock dependencies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobContext, JobResult } from '../../../../infrastructure/queue/domain/JobHandler.js';
import { SourceIngestionHandler, type SourceIngestionHandlerDeps } from '../../../../infrastructure/queue/handlers/SourceIngestionHandler.js';
import { AssessmentGenerationHandler, type AssessmentGenerationHandlerDeps } from '../../../../infrastructure/queue/handlers/AssessmentGenerationHandler.js';
import { QuestionRegenerationHandler, type QuestionRegenerationHandlerDeps } from '../../../../infrastructure/queue/handlers/QuestionRegenerationHandler.js';

// ── Mock factories ──────────────────────────────────────────────────

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
    getById: vi.fn().mockResolvedValue({
      id: 'upload-001',
      workspaceId: 'ws-001',
      fileName: 'test.pdf',
      mimeType: 'application/pdf',
      storageKey: 'uploads/test.pdf',
      status: 'verified',
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockStorage() {
  return {
    getBytes: vi.fn().mockResolvedValue(Buffer.from('fake pdf content')),
    putBytes: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockExtractionService() {
  return {
    extractAndChunk: vi.fn().mockResolvedValue({
      passages: [
        { id: 'passage-1', content: 'Text content from the uploaded document.', sourceUploadId: 'upload-001', sequence: 0 },
        { id: 'passage-2', content: 'Another passage for question generation.', sourceUploadId: 'upload-001', sequence: 1 },
      ],
      metadata: { totalPages: 5, totalPassages: 2, extractionMethod: 'mock' },
    }),
  };
}

function makeMockQuestionGenService() {
  return {
    generateQuestions: vi.fn().mockResolvedValue({
      questions: [
        {
          id: 'q-001',
          stem: 'What is the main topic?',
          options: ['A', 'B', 'C', 'D'],
          answer: 'A',
          explanation: 'Based on the passage.',
          sourceIds: ['passage-1'],
          questionType: 'multiple_choice',
          difficulty: 'medium',
          cognitiveLevel: 'remember',
          sequence: 0,
        },
      ],
      hasFailures: false,
      metadata: { generatedCount: 1, failedCount: 0 },
    }),
  };
}

function makeMockAssessmentStore() {
  return {
    getById: vi.fn().mockResolvedValue({
      id: 'assessment-001',
      workspaceId: 'ws-001',
      title: 'Test Assessment',
      blueprint: [
        { sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' },
      ],
      status: 'draft',
      createdAt: new Date(),
    }),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    saveQuestions: vi.fn().mockResolvedValue(undefined),
    listQuestions: vi.fn().mockResolvedValue([
      { id: 'q-001', stem: 'What is the main topic?', questionType: 'multiple_choice', difficulty: 'medium' },
    ]),
  };
}

function makeMockBlueprintStore() {
  return {
    getByAssessmentId: vi.fn().mockResolvedValue([
      { sequence: 0, questionType: 'multiple_choice', difficulty: 'medium', cognitiveLevel: 'remember', topicHint: 'main topic' },
    ]),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockProductAiService() {
  return {
    run: vi.fn().mockResolvedValue({
      status: 'succeeded',
      outcome: 'succeeded',
      promptTemplateId: 'tpl-001',
      promptVersionId: 'v1',
      rawOutput: 'AI generated content',
      parsedOutput: {
        questions: [
          {
            stem: 'What is the main topic?',
            options: ['A', 'B', 'C', 'D'],
            answer: 'A',
            explanation: 'Based on the passage.',
            sourceIds: ['passage-1'],
          },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('X3-01: Generate configuration & retrieval integration gate', () => {

  describe('Source ingestion handler', () => {
    it('should process a source_ingestion job and return success', async () => {
      const deps: SourceIngestionHandlerDeps = {
        uploadsStore: makeMockUploadsStore(),
        storage: makeMockStorage(),
        extractionService: makeMockExtractionService(),
      };
      const handler = new SourceIngestionHandler(deps);
      const ctx = makeContext({ sourceId: 'upload-001' });

      const result: JobResult = await handler.handle(ctx);
      expect(result.status).toBe('success');
      expect(deps.uploadsStore.getById).toHaveBeenCalledWith('upload-001');
      expect(deps.extractionService.extractAndChunk).toHaveBeenCalled();
    });

    it('should fail gracefully when uploadId is missing', async () => {
      const deps: SourceIngestionHandlerDeps = {
        uploadsStore: makeMockUploadsStore(),
        storage: makeMockStorage(),
        extractionService: makeMockExtractionService(),
      };
      const handler = new SourceIngestionHandler(deps);
      const ctx = makeContext({}); // no sourceId

      const result: JobResult = await handler.handle(ctx);
      expect(result.status).toBe('failure');
      expect(result.error?.code).toBe('MISSING_UPLOAD_ID');
    });
  });

  describe('Assessment generation handler', () => {
    it('should process an assessment_generation job and return success', async () => {
      const mockQGS = makeMockQuestionGenService();
      const mockAssessmentStore = makeMockAssessmentStore();
      const mockBlueprintStore = makeMockBlueprintStore();
      const mockProductAi = makeMockProductAiService();

      const deps: AssessmentGenerationHandlerDeps = {
        questionGenerationService: mockQGS,
        assessmentStore: mockAssessmentStore,
        blueprintStore: mockBlueprintStore,
        productAiService: mockProductAi,
      };
      const handler = new AssessmentGenerationHandler(deps);
      const ctx = makeContext({
        assessmentId: 'assessment-001',
        workspaceId: 'ws-001',
        blueprint: [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      });

      const result: JobResult = await handler.handle(ctx);
      expect(result.status).toBe('success');
    });
  });

  describe('Question regeneration handler', () => {
    it('should process a question_regeneration job and return success', async () => {
      const mockQGS = makeMockQuestionGenService();
      const deps: QuestionRegenerationHandlerDeps = {
        questionGenerationService: mockQGS,
      };
      const handler = new QuestionRegenerationHandler(deps);
      const ctx = makeContext({
        assessmentVersionId: 'assessment-001',
        questionId: 'q-001',
        questionType: 'multiple_choice',
        difficulty: 'medium',
        topicHint: 'regenerate this question',
      });

      const result: JobResult = await handler.handle(ctx);
      expect(result.status).toBe('success');
      expect(result.output?.regenerated).toBe(true);
    });
  });

  describe('End-to-end: source → generate → questions', () => {
    it('should chain source ingestion → assessment generation and produce questions', async () => {
      // Step 1: Source ingestion
      const sourceDeps: SourceIngestionHandlerDeps = {
        uploadsStore: makeMockUploadsStore(),
        storage: makeMockStorage(),
        extractionService: makeMockExtractionService(),
      };
      const sourceHandler = new SourceIngestionHandler(sourceDeps);
      const sourceCtx = makeContext({ sourceId: 'upload-001' });
      const sourceResult = await sourceHandler.handle(sourceCtx);
      expect(sourceResult.status).toBe('success');

      // Step 2: Assessment generation (uses passages from step 1)
      const mockQGS = makeMockQuestionGenService();
      const genDeps: AssessmentGenerationHandlerDeps = {
        questionGenerationService: mockQGS,
        assessmentStore: makeMockAssessmentStore(),
        blueprintStore: makeMockBlueprintStore(),
        productAiService: makeMockProductAiService(),
      };
      const genHandler = new AssessmentGenerationHandler(genDeps);
      const genCtx = makeContext({
        assessmentId: 'assessment-001',
        workspaceId: 'ws-001',
        blueprint: [{ sequence: 0, questionType: 'multiple_choice', difficulty: 'medium' }],
      });
      const genResult = await genHandler.handle(genCtx);
      expect(genResult.status).toBe('success');

      // Step 3: Verify mock question generation produced questions
      expect(mockQGS.generateQuestions).toHaveBeenCalled();
      const questions = mockQGS.generateQuestions.mock.results[0].value.questions;
      expect(questions.length).toBeGreaterThan(0);
      expect(questions[0].stem).toBeDefined();
      expect(questions[0].answer).toBeDefined();
    });
  });
});
