/**
 * B2-03..B4-04 — Public re-exports for the assessments module.
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

// B4-01..B4-04 — Question review, regeneration, conflict, finalization
export {
  QuestionReviewService,
  QuestionNotFoundError,
  QuestionEtagMismatchError,
  QuestionFinalizedError,
  QuestionNoCandidateError,
  QuestionsPendingError,
  AssessmentVersionNotFinalizedError,
  computeEtag,
} from './application/QuestionReviewService.js';

export type { QuestionReviewServiceOptions } from './application/QuestionReviewService.js';

export { FinalizationService } from './application/FinalizationService.js';
export type {
  FinalizationServiceOptions,
  FinalizeResult,
} from './application/FinalizationService.js';

export type {
  ReviewedQuestion,
  QuestionReviewStatus,
  QuestionAuditEntry,
  QuestionAuditAction,
  AssessmentFinalization,
  EditReviewedQuestionInput,
  QuestionReviewStore,
} from './domain/QuestionReview.js';

export { InMemoryAssessmentsStore } from './persistence/InMemoryAssessmentsStore.js';
export { InMemoryBlueprintPipelineStore } from './persistence/InMemoryBlueprintPipelineStore.js';
export { InMemoryQuestionGenerationStore } from './persistence/InMemoryQuestionGenerationStore.js';
export { InMemoryQuestionReviewStore } from './persistence/InMemoryQuestionReviewStore.js';

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
export { registerQuestionReviewRoutes } from './adapters/http/questionReviewRoutes.js';

// B5-01
export { PrintService } from './application/PrintService.js';
export type { PrintServiceOptions } from './application/PrintService.js';
export { renderPrintHtml } from './application/printTemplate.js';
export { registerPrintRoutes } from './adapters/http/printRoutes.js';
export type { PrintDocument, PrintDocumentMeta, PrintQuestion, PrintQuestionOption } from './domain/PrintDocument.js';
export { PRINT_DTO_VERSION } from './domain/PrintDocument.js';

// B5-02
export { PrintArtifactService } from './application/PrintArtifactService.js';
export type { PrintArtifactServiceOptions, TriggerRenderResult, ArtifactInfoResult } from './application/PrintArtifactService.js';
export { registerArtifactRoutes } from './adapters/http/artifactRoutes.js';
export type { PrintArtifact, PrintArtifactStore, ArtifactStatus } from './domain/PrintArtifact.js';
export { InMemoryPrintArtifactStore } from './persistence/InMemoryPrintArtifactStore.js';
