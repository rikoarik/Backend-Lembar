/**
 * B2-03 — Public re-exports for the assessments module.
 */
export type {
  Assessment,
  AssessmentStatus,
  AssessmentVersion,
  AssessmentVersionStatus,
  BlueprintItem,
  BlueprintItemConfig,
  AssessmentConfigSnapshot,
  QuestionType,
  Difficulty,
  CreateAssessmentInput,
  CreateAssessmentVersionInput,
  CreateBlueprintItemInput,
  AssessmentsStore,
} from './domain/Assessment.js';

export type {
  BlueprintSchemaVersion,
  BlueprintItemSchema,
  CoverageTargets,
  BlueprintSnapshot,
  BlueprintSnapshotItem,
  SourceEvidence,
  BlueprintValidationResult,
  BlueprintValidationError,
  BlueprintValidationErrorCode,
  BlueprintValidationWarning,
  CoverageReport,
  CoverageViolation,
  BuildBlueprintInput,
  BuildBlueprintResult,
  BlueprintPipelineStore,
} from './domain/BlueprintPipeline.js';

export { AssessmentService, createAssessmentService } from './application/AssessmentService.js';

export type {
  CreateAssessmentConfigInput,
  AssessmentConfigResult,
  BlueprintItemRequest,
} from './application/AssessmentService.js';

export {
  BlueprintPipelineService,
  createBlueprintPipelineService,
  BLUEPRINT_SCHEMA_V1,
  DEFAULT_COVERAGE_TARGETS,
} from './application/BlueprintPipelineService.js';

export {
  QuestionGenerationService,
  createQuestionGenerationService,
  QUESTION_OUTPUT_SCHEMA,
} from './application/QuestionGenerationService.js';

export type {
  GeneratedQuestion,
  QuestionOption,
  QuestionVersionMetadata,
  GenerateQuestionsInput,
  GenerateQuestionsResult,
  QuestionGenerationFailure,
  QuestionGenerationStore,
} from './domain/QuestionGeneration.js';

export { InMemoryAssessmentsStore } from './persistence/InMemoryAssessmentsStore.js';
export { InMemoryBlueprintPipelineStore } from './persistence/InMemoryBlueprintPipelineStore.js';
export { InMemoryQuestionGenerationStore } from './persistence/InMemoryQuestionGenerationStore.js';

export {
  QualityService,
  runDeterministicChecks,
  buildCriticPrompt,
  containsPromptInjection,
} from './quality/QualityService.js';
export { InMemoryQualityStore } from './quality/InMemoryQualityStore.js';
export {
  DEFAULT_QUALITY_RULES,
  QUALITY_RULESET_VERSION,
  mergeQualityRules,
} from './quality/Quality.js';
export type {
  QualityIssueCode,
  QualityRuleSet,
  QualityIssue,
  StoredCriticResult,
  QualitySummary,
  QualityResult,
  QualityCheckInput,
  QualityStore,
  CriticQuestion,
  QualityCriticInput,
  QualityCriticEvaluation,
  QualityCriticEvaluator,
} from './quality/Quality.js';

export { registerAssessmentRoutes } from './adapters/http/routes.js';
export { registerBlueprintPipelineRoutes } from './adapters/http/blueprintRoutes.js';
