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

export { AssessmentService, createAssessmentService } from './application/AssessmentService.js';

export type {
  CreateAssessmentConfigInput,
  AssessmentConfigResult,
  BlueprintItemRequest,
} from './application/AssessmentService.js';

export { InMemoryAssessmentsStore } from './persistence/InMemoryAssessmentsStore.js';

export { registerAssessmentRoutes } from './adapters/http/routes.js';
