import { describe, it, expect, beforeEach } from 'vitest';
import { QuestionGenerationService } from '../../../src/modules/assessments/application/QuestionGenerationService.js';
import { InMemoryQuestionGenerationStore } from '../../../src/modules/assessments/persistence/InMemoryQuestionGenerationStore.js';
import type { AiEnv } from '../../../src/config/ai.env.js';
import type { BlueprintSnapshot } from '../../../src/modules/assessments/domain/BlueprintPipeline.js';
import type {
  ProductAiService,
  ProductAiResult,
} from '../../../src/infrastructure/ai/application/ProductAiService.js';
import type { BlueprintPipelineService } from '../../../src/modules/assessments/application/BlueprintPipelineService.js';

// ---- Test fixtures ----

const WORKSPACE_ID = 'test-workspace-001';
const ASSESSMENT_VERSION_ID = 'av-001';
const BLUEPRINT_ID = 'bp-001';

const TEST_AI_ENV: AiEnv = {
  driver: 'mock',
  modelId: 'test-model-v1',
  schemaRepairMaxAttempts: 1,
  tokenEstimateFallbackChars: 4,
  baseUrl: null,
  apiKeyPresent: false,
  timeoutMs: 30_000,
};

const VALID_BLUEPRINT: BlueprintSnapshot = {
  id: BLUEPRINT_ID,
  workspaceId: WORKSPACE_ID,
  assessmentVersionId: ASSESSMENT_VERSION_ID,
  blueprintSchemaVersion: '1.0.0',
  items: [
    {
      sequence: 0,
      questionType: 'multiple_choice',
      difficulty: 'medium',
      cognitiveLevel: 'understand',
      topicHint: 'Algebra',
      outcomeId: null,
      sourceUploadId: null,
      citationIds: [],
    },
    {
      sequence: 1,
      questionType: 'short_answer',
      difficulty: 'easy',
      cognitiveLevel: 'remember',
      topicHint: 'Geometry',
      outcomeId: null,
      sourceUploadId: null,
      citationIds: [],
    },
  ],
  coverageReport: {
    totalItems: 2,
    difficultyCounts: { easy: 1, medium: 1, hard: 0 },
    questionTypeCounts: { multiple_choice: 1, short_answer: 1, essay: 0, true_false: 0 },
    itemsWithSource: 0,
    sourceCoverageFraction: 0,
    meetsTargets: true,
    violations: [],
  },
  sourceEvidence: [],
  createdAt: new Date().toISOString(),
};

function makeValidAiResponse(): ProductAiResult {
  return {
    status: 'succeeded',
    outcome: 'succeeded',
    promptTemplateId: 'question-generation-v1',
    providerModelId: 'test-model-v1',
    schemaRepairAttempts: 0,
    requestTokenEstimate: 100,
    responseTokenCount: 50,
    validated: {
      stem: 'What is 2 + 2?',
      options: [
        { key: 'A', text: '3' },
        { key: 'B', text: '4' },
        { key: 'C', text: '5' },
      ],
      answer: 'B',
      explanation: 'Basic arithmetic.',
      sourceIds: [],
    },
    latencyMs: 150,
  };
}

function makeSchemaRepairExhaustedAiResponse(): ProductAiResult {
  return {
    status: 'failed',
    outcome: 'schema_invalid',
    error: {
      name: 'AiAdapterError',
      code: 'SCHEMA_VALIDATION_FAILED',
      message: 'Schema validation failed after repair attempts.',
      outcome: 'schema_repair',
      redactedPromptFingerprint: 'fingerprint:[prompt]',
      redactedResponseFingerprint: 'fingerprint:[response]',
      retryAfterMs: null,
      schemaRepairAttempt: 1,
      driver: 'mock',
      cause: null,
    },
    schemaRepairAttempts: 1,
    latencyMs: 200,
  };
}

function makeRateLimitedAiResponse(): ProductAiResult {
  return {
    status: 'failed',
    outcome: 'rate_limited',
    error: {
      name: 'AiAdapterError',
      code: 'RATE_LIMITED',
      message: 'Rate limited.',
      outcome: 'rate_limited',
      redactedPromptFingerprint: 'fingerprint:[prompt]',
      redactedResponseFingerprint: 'fingerprint:[response]',
      retryAfterMs: 1000,
      schemaRepairAttempt: 0,
      driver: 'mock',
      cause: null,
    },
    schemaRepairAttempts: 0,
    latencyMs: 100,
  };
}

function makeRefusedAiResponse(): ProductAiResult {
  return {
    status: 'failed',
    outcome: 'refused',
    error: {
      name: 'AiAdapterError',
      code: 'PROVIDER_REFUSED',
      message: 'Provider refused.',
      outcome: 'refused',
      redactedPromptFingerprint: 'fingerprint:[prompt]',
      redactedResponseFingerprint: 'fingerprint:[response]',
      retryAfterMs: null,
      schemaRepairAttempt: 0,
      driver: 'mock',
      cause: null,
    },
    schemaRepairAttempts: 0,
    latencyMs: 100,
  };
}

function makeInternalErrorAiResponse(): ProductAiResult {
  return {
    status: 'failed',
    outcome: 'error',
    error: {
      name: 'AiAdapterError',
      code: 'INTERNAL_ERROR',
      message: 'Internal error.',
      outcome: 'error',
      redactedPromptFingerprint: 'fingerprint:[prompt]',
      redactedResponseFingerprint: 'fingerprint:[response]',
      retryAfterMs: null,
      schemaRepairAttempt: 0,
      driver: 'mock',
      cause: null,
    },
    schemaRepairAttempts: 0,
    latencyMs: 100,
  };
}

// ---- Mock factories ----

function createMockAiService(responses: ProductAiResult[]): ProductAiService {
  let callIndex = 0;
  return {
    run: async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      return response;
    },
  } as unknown as ProductAiService;
}

function createMockBlueprintService(blueprint: BlueprintSnapshot | null): BlueprintPipelineService {
  return {
    getBlueprint: async () => blueprint,
    buildBlueprint: async () => ({
      snapshot: blueprint!,
      validation: { valid: true, errors: [] },
      cached: false,
    }),
  } as unknown as BlueprintPipelineService;
}

// ---- Tests ----

describe('B3-03 QuestionGenerationService', () => {
  let questionStore: InMemoryQuestionGenerationStore;

  beforeEach(() => {
    questionStore = new InMemoryQuestionGenerationStore();
  });

  describe('Schema-repair cap tests', () => {
    it('should stop retrying after maxSchemaRepairAttempts and surface failure', async () => {
      const aiService = createMockAiService([makeSchemaRepairExhaustedAiResponse()]);
      const blueprintService = createMockBlueprintService(VALID_BLUEPRINT);
      const service = new QuestionGenerationService({
        store: questionStore,
        blueprintService,
        aiService,
        env: TEST_AI_ENV,
      });

      const result = await service.generateQuestions({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: ASSESSMENT_VERSION_ID,
        blueprintItems: VALID_BLUEPRINT.items,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { minTotalItems: 1, maxTotalItems: 10 },
        requestId: 'req-1',
      });

      expect(result.hasFailures).toBe(true);
      expect(result.failures).toHaveLength(2);
      expect(result.failures[0]!.reason).toBe('schema_repair_exhausted');
      expect(result.failures[1]!.reason).toBe('schema_repair_exhausted');
    });

    it('should attempt exactly schemaRepairMaxAttempts + 1 times per item', async () => {
      let callCount = 0;
      const aiService = {
        run: async () => {
          callCount++;
          return makeSchemaRepairExhaustedAiResponse();
        },
      } as unknown as ProductAiService;
      const blueprintService = createMockBlueprintService(VALID_BLUEPRINT);
      const zeroRepairEnv: AiEnv = { ...TEST_AI_ENV, schemaRepairMaxAttempts: 0 };
      const service = new QuestionGenerationService({
        store: questionStore,
        blueprintService,
        aiService,
        env: zeroRepairEnv,
      });

      await service.generateQuestions({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: ASSESSMENT_VERSION_ID,
        blueprintItems: VALID_BLUEPRINT.items,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { minTotalItems: 1, maxTotalItems: 10 },
        requestId: 'req-1',
      });

      // 0 repairs + 1 initial = 1 attempt per item, 2 items = 2 calls
      expect(callCount).toBe(2);
    });

    it('should succeed on first valid response without repair attempts', async () => {
      const aiService = createMockAiService([makeValidAiResponse()]);
      const blueprintService = createMockBlueprintService(VALID_BLUEPRINT);
      const service = new QuestionGenerationService({
        store: questionStore,
        blueprintService,
        aiService,
        env: TEST_AI_ENV,
      });

      const result = await service.generateQuestions({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: ASSESSMENT_VERSION_ID,
        blueprintItems: VALID_BLUEPRINT.items,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { minTotalItems: 1, maxTotalItems: 10 },
        requestId: 'req-1',
      });

      expect(result.hasFailures).toBe(false);
      expect(result.questions).toHaveLength(2);
      expect(result.questions[0]!.versionMetadata.schemaRepairAttempts).toBe(0);
    });

    it('should accumulate schemaRepairAttempts across items', async () => {
      // First item fails, second succeeds
      const aiService = createMockAiService([
        makeSchemaRepairExhaustedAiResponse(),
        makeValidAiResponse(),
      ]);
      const blueprintService = createMockBlueprintService(VALID_BLUEPRINT);
      const service = new QuestionGenerationService({
        store: questionStore,
        blueprintService,
        aiService,
        env: TEST_AI_ENV,
      });

      const result = await service.generateQuestions({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: ASSESSMENT_VERSION_ID,
        blueprintItems: VALID_BLUEPRINT.items,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { minTotalItems: 1, maxTotalItems: 10 },
        requestId: 'req-1',
      });

      expect(result.hasFailures).toBe(true);
      expect(result.questions).toHaveLength(1);
      expect(result.totalSchemaRepairAttempts).toBe(1);
    });
  });

  describe('Provider-mocks tests', () => {
    it('should handle rate_limited outcome', async () => {
      const aiService = createMockAiService([makeRateLimitedAiResponse()]);
      const blueprintService = createMockBlueprintService(VALID_BLUEPRINT);
      const service = new QuestionGenerationService({
        store: questionStore,
        blueprintService,
        aiService,
        env: TEST_AI_ENV,
      });

      const result = await service.generateQuestions({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: ASSESSMENT_VERSION_ID,
        blueprintItems: VALID_BLUEPRINT.items,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { minTotalItems: 1, maxTotalItems: 10 },
        requestId: 'req-1',
      });

      expect(result.hasFailures).toBe(true);
      expect(result.failures[0]!.reason).toBe('provider_error');
    });

    it('should handle refused outcome', async () => {
      const aiService = createMockAiService([makeRefusedAiResponse()]);
      const blueprintService = createMockBlueprintService(VALID_BLUEPRINT);
      const service = new QuestionGenerationService({
        store: questionStore,
        blueprintService,
        aiService,
        env: TEST_AI_ENV,
      });

      const result = await service.generateQuestions({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: ASSESSMENT_VERSION_ID,
        blueprintItems: VALID_BLUEPRINT.items,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { minTotalItems: 1, maxTotalItems: 10 },
        requestId: 'req-1',
      });

      expect(result.hasFailures).toBe(true);
      expect(result.failures[0]!.reason).toBe('provider_error');
    });

    it('should handle internal error outcome', async () => {
      const aiService = createMockAiService([makeInternalErrorAiResponse()]);
      const blueprintService = createMockBlueprintService(VALID_BLUEPRINT);
      const service = new QuestionGenerationService({
        store: questionStore,
        blueprintService,
        aiService,
        env: TEST_AI_ENV,
      });

      const result = await service.generateQuestions({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: ASSESSMENT_VERSION_ID,
        blueprintItems: VALID_BLUEPRINT.items,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { minTotalItems: 1, maxTotalItems: 10 },
        requestId: 'req-1',
      });

      expect(result.hasFailures).toBe(true);
      expect(result.failures[0]!.reason).toBe('provider_error');
    });

    it('should return cached questions on second call', async () => {
      const aiService = createMockAiService([makeValidAiResponse()]);
      const blueprintService = createMockBlueprintService(VALID_BLUEPRINT);
      const service = new QuestionGenerationService({
        store: questionStore,
        blueprintService,
        aiService,
        env: TEST_AI_ENV,
      });

      const first = await service.generateQuestions({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: ASSESSMENT_VERSION_ID,
        blueprintItems: VALID_BLUEPRINT.items,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { minTotalItems: 1, maxTotalItems: 10 },
        requestId: 'req-1',
      });

      const second = await service.generateQuestions({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: ASSESSMENT_VERSION_ID,
        blueprintItems: VALID_BLUEPRINT.items,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { minTotalItems: 1, maxTotalItems: 10 },
        requestId: 'req-2',
      });

      // Blueprint has 2 items, so 2 questions generated
      expect(first.questions).toHaveLength(2);
      expect(second.questions).toHaveLength(2);
      expect(second.questions[0]!.id).toBe(first.questions[0]!.id);
      expect(second.questions[1]!.id).toBe(first.questions[1]!.id);
      expect(second.totalSchemaRepairAttempts).toBe(0);
    });

    it('should throw RESOURCE_NOT_FOUND when blueprint missing', async () => {
      const aiService = createMockAiService([makeValidAiResponse()]);
      const blueprintService = createMockBlueprintService(null);
      const service = new QuestionGenerationService({
        store: questionStore,
        blueprintService,
        aiService,
        env: TEST_AI_ENV,
      });

      await expect(
        service.generateQuestions({
          workspaceId: WORKSPACE_ID,
          assessmentVersionId: ASSESSMENT_VERSION_ID,
          blueprintItems: [VALID_BLUEPRINT.items[0]!],
          blueprintSchemaVersion: '1.0.0',
          coverageTargets: { minTotalItems: 1, maxTotalItems: 10 },
          requestId: 'req-1',
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });
  });

  describe('Version-metadata tests', () => {
    it('should pin blueprintSchemaVersion from blueprint snapshot', async () => {
      const aiService = createMockAiService([makeValidAiResponse()]);
      const blueprintService = createMockBlueprintService(VALID_BLUEPRINT);
      const service = new QuestionGenerationService({
        store: questionStore,
        blueprintService,
        aiService,
        env: TEST_AI_ENV,
      });

      const result = await service.generateQuestions({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: ASSESSMENT_VERSION_ID,
        blueprintItems: VALID_BLUEPRINT.items,
        blueprintSchemaVersion: '2.5.0',
        coverageTargets: { minTotalItems: 1, maxTotalItems: 10 },
        requestId: 'req-1',
      });

      // Service uses blueprint's schema version, not input's
      expect(result.questions[0]!.versionMetadata.blueprintSchemaVersion).toBe('1.0.0');
    });

    it('should pin providerModelId from AiEnv', async () => {
      const customEnv: AiEnv = { ...TEST_AI_ENV, modelId: 'custom-model-xyz' };
      const aiService = createMockAiService([makeValidAiResponse()]);
      const blueprintService = createMockBlueprintService(VALID_BLUEPRINT);
      const service = new QuestionGenerationService({
        store: questionStore,
        blueprintService,
        aiService,
        env: customEnv,
      });

      const result = await service.generateQuestions({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: ASSESSMENT_VERSION_ID,
        blueprintItems: VALID_BLUEPRINT.items,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { minTotalItems: 1, maxTotalItems: 10 },
        requestId: 'req-1',
      });

      expect(result.questions[0]!.versionMetadata.providerModelId).toBe('test-model-v1');
    });

    it('should pin promptTemplateId as question-generation-v1', async () => {
      const aiService = createMockAiService([makeValidAiResponse()]);
      const blueprintService = createMockBlueprintService(VALID_BLUEPRINT);
      const service = new QuestionGenerationService({
        store: questionStore,
        blueprintService,
        aiService,
        env: TEST_AI_ENV,
      });

      const result = await service.generateQuestions({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: ASSESSMENT_VERSION_ID,
        blueprintItems: VALID_BLUEPRINT.items,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { minTotalItems: 1, maxTotalItems: 10 },
        requestId: 'req-1',
      });

      expect(result.questions[0]!.versionMetadata.promptTemplateId).toBe('question-generation-v1');
    });

    it('should track schemaRepairAttempts in version metadata', async () => {
      const aiService = createMockAiService([makeValidAiResponse()]);
      const blueprintService = createMockBlueprintService(VALID_BLUEPRINT);
      const service = new QuestionGenerationService({
        store: questionStore,
        blueprintService,
        aiService,
        env: TEST_AI_ENV,
      });

      const result = await service.generateQuestions({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: ASSESSMENT_VERSION_ID,
        blueprintItems: VALID_BLUEPRINT.items,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { minTotalItems: 1, maxTotalItems: 10 },
        requestId: 'req-1',
      });

      expect(result.questions[0]!.versionMetadata.schemaRepairAttempts).toBe(0);
    });

    it('should include latencyMs in version metadata', async () => {
      const aiService = createMockAiService([makeValidAiResponse()]);
      const blueprintService = createMockBlueprintService(VALID_BLUEPRINT);
      const service = new QuestionGenerationService({
        store: questionStore,
        blueprintService,
        aiService,
        env: TEST_AI_ENV,
      });

      const result = await service.generateQuestions({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: ASSESSMENT_VERSION_ID,
        blueprintItems: VALID_BLUEPRINT.items,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { minTotalItems: 1, maxTotalItems: 10 },
        requestId: 'req-1',
      });

      expect(result.questions[0]!.versionMetadata.latencyMs).toBe(150);
    });

    it('should preserve version metadata across cached retrievals', async () => {
      const aiService = createMockAiService([makeValidAiResponse()]);
      const blueprintService = createMockBlueprintService(VALID_BLUEPRINT);
      const service = new QuestionGenerationService({
        store: questionStore,
        blueprintService,
        aiService,
        env: TEST_AI_ENV,
      });

      const first = await service.generateQuestions({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: ASSESSMENT_VERSION_ID,
        blueprintItems: VALID_BLUEPRINT.items,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { minTotalItems: 1, maxTotalItems: 10 },
        requestId: 'req-1',
      });

      const second = await service.generateQuestions({
        workspaceId: WORKSPACE_ID,
        assessmentVersionId: ASSESSMENT_VERSION_ID,
        blueprintItems: VALID_BLUEPRINT.items,
        blueprintSchemaVersion: '1.0.0',
        coverageTargets: { minTotalItems: 1, maxTotalItems: 10 },
        requestId: 'req-2',
      });

      expect(second.questions[0]!.versionMetadata.blueprintSchemaVersion).toBe(
        first.questions[0]!.versionMetadata.blueprintSchemaVersion,
      );
      expect(second.questions[0]!.versionMetadata.providerModelId).toBe(
        first.questions[0]!.versionMetadata.providerModelId,
      );
      expect(second.questions[0]!.versionMetadata.promptTemplateId).toBe(
        first.questions[0]!.versionMetadata.promptTemplateId,
      );
    });
  });
});
