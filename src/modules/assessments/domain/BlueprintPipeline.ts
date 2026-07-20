/**
 * B3-02 — Domain types for the blueprint pipeline.
 *
 * The blueprint pipeline transforms an AssessmentVersion's config snapshot into
 * a validated, schema-constrained blueprint with coverage enforcement.
 *
 * Key invariants:
 * - BlueprintSnapshot is immutable after creation (D-013).
 * - Blueprint schema is versioned; snapshots pin the schema version used.
 * - Coverage targets define distribution requirements (difficulty, question types).
 * - Insufficient-source conditions are terminal and surface actionable reasons.
 */

import type { QuestionType, Difficulty } from './Assessment.js';

// ---- Blueprint schema ----

export interface BlueprintSchemaVersion {
  /** Semver string, e.g. "1.0.0" */
  version: string;
  /** ISO timestamp when this schema version was published */
  publishedAt: string;
  /** JSON Schema definition for blueprint item validation */
  itemSchema: BlueprintItemSchema;
}

export interface BlueprintItemSchema {
  /** Required properties on each blueprint item */
  requiredFields: readonly string[];
  /** Allowed question types for this schema version */
  allowedQuestionTypes: readonly QuestionType[];
  /** Allowed difficulty levels */
  allowedDifficulties: readonly Difficulty[];
  /** Allowed cognitive levels (null = any string accepted) */
  allowedCognitiveLevels: readonly string[] | null;
  /** Maximum sequence value */
  maxSequence: number;
  /** Whether sourceUploadId is required on each item */
  requireSourceUploadId: boolean;
}

// ---- Coverage targets ----

export interface CoverageTargets {
  /** Minimum total items required */
  minTotalItems: number;
  /** Maximum total items allowed */
  maxTotalItems: number;
  /** Required distribution of difficulties (fraction 0..1 per bucket) */
  difficultyDistribution: Partial<Record<Difficulty, number>>;
  /** Required distribution of question types (fraction 0..1 per bucket) */
  questionTypeDistribution: Partial<Record<QuestionType, number>>;
  /** Minimum fraction of items that must have a sourceUploadId */
  minSourceCoverage: number;
}

// ---- Blueprint snapshot (immutable, persisted) ----

export interface BlueprintSnapshot {
  id: string;
  assessmentVersionId: string;
  workspaceId: string;
  /** The schema version used to validate this blueprint */
  blueprintSchemaVersion: string;
  /** Immutable JSON of the validated blueprint items */
  items: BlueprintSnapshotItem[];
  /** Coverage analysis result at snapshot time */
  coverageReport: CoverageReport;
  /** Passages used as source grounding evidence */
  sourceEvidence: SourceEvidence[];
  createdAt: string;
}

export interface BlueprintSnapshotItem {
  sequence: number;
  questionType: QuestionType;
  difficulty: Difficulty;
  cognitiveLevel: string | null;
  topicHint: string | null;
  outcomeId: string | null;
  sourceUploadId: string | null;
  /** Passage IDs that ground this item */
  citationIds: string[];
}

// ---- Source evidence ----

export interface SourceEvidence {
  uploadId: string;
  passageCount: number;
  totalCharCount: number;
}

// ---- Validation result ----

export interface BlueprintValidationResult {
  valid: boolean;
  errors: BlueprintValidationError[];
  warnings: BlueprintValidationWarning[];
}

export interface BlueprintValidationError {
  code: BlueprintValidationErrorCode;
  message: string;
  field?: string;
  sequence?: number;
}

export type BlueprintValidationErrorCode =
  | 'schema_version_mismatch'
  | 'invalid_question_type'
  | 'invalid_difficulty'
  | 'invalid_cognitive_level'
  | 'sequence_out_of_range'
  | 'duplicate_sequence'
  | 'missing_source_upload_id'
  | 'total_items_below_min'
  | 'total_items_above_max'
  | 'difficulty_distribution_mismatch'
  | 'question_type_distribution_mismatch'
  | 'source_coverage_below_min';

export interface BlueprintValidationWarning {
  code: string;
  message: string;
  field?: string;
  sequence?: number;
}

// ---- Coverage report ----

export interface CoverageReport {
  totalItems: number;
  difficultyCounts: Record<Difficulty, number>;
  questionTypeCounts: Record<QuestionType, number>;
  itemsWithSource: number;
  sourceCoverageFraction: number;
  meetsTargets: boolean;
  violations: CoverageViolation[];
}

export interface CoverageViolation {
  target: string;
  expected: number;
  actual: number;
  message: string;
}

// ---- Pipeline input/output ----

export interface BuildBlueprintInput {
  workspaceId: string;
  assessmentVersionId: string;
  /** Schema version to validate against */
  blueprintSchemaVersion: string;
  /** Coverage targets to enforce */
  coverageTargets: CoverageTargets;
  requestId: string;
}

export interface BuildBlueprintResult {
  snapshot: BlueprintSnapshot;
  validation: BlueprintValidationResult;
  /** True if a cached snapshot already existed for this version */
  cached: boolean;
}

// ---- Store contract ----

export interface BlueprintPipelineStore {
  saveSnapshot(snapshot: BlueprintSnapshot): Promise<BlueprintSnapshot>;
  getSnapshotByAssessmentVersionId(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<BlueprintSnapshot | null>;
  getSchemaVersion(version: string): Promise<BlueprintSchemaVersion | null>;
}
