/**
 * B2-03 — Domain types for assessment configuration and draft.
 *
 * Assessment lifecycle:
 *   draft → generating → ready | failed → archived
 *
 * Key invariants:
 * - Every assessment is workspace-scoped; reads always require workspaceId.
 * - AssessmentVersion.configSnapshot is immutable after creation.
 * - BlueprintItem sequences are 0-indexed per version.
 * - Catalog and source IDs are opaque references; validation happens in
 *   AssessmentService, not in the domain types.
 */

export type AssessmentStatus = 'draft' | 'generating' | 'ready' | 'failed' | 'archived';
export type AssessmentVersionStatus = 'draft' | 'generating' | 'ready' | 'failed';
export type QuestionType = 'multiple_choice' | 'short_answer' | 'essay' | 'true_false';
export type Difficulty = 'easy' | 'medium' | 'hard';

export interface Assessment {
  id: string;
  workspaceId: string;
  creatorUserId: string;
  title: string;
  status: AssessmentStatus;
  currentVersion: number;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssessmentVersion {
  id: string;
  assessmentId: string;
  workspaceId: string;
  version: number;
  status: AssessmentVersionStatus;
  /** Immutable JSON snapshot of catalog + source config at submission time. */
  configSnapshot: AssessmentConfigSnapshot;
  schemaVersion: string;
  createdAt: string;
}

export interface BlueprintItem {
  id: string;
  assessmentVersionId: string;
  workspaceId: string;
  sequence: number;
  curriculumVersionId: string | null;
  outcomeId: string | null;
  subjectId: string | null;
  gradeId: string | null;
  questionType: QuestionType;
  difficulty: Difficulty;
  cognitiveLevel: string | null;
  topicHint: string | null;
  sourceUploadId: string | null;
  createdAt: string;
}

/**
 * The immutable config snapshot stored on AssessmentVersion.
 * Captures exact catalog + source IDs at submission time so later
 * catalog updates don't silently change what was generated.
 */
export interface AssessmentConfigSnapshot {
  schemaVersion: '1';
  title: string;
  curriculumVersionId: string;
  gradeId: string;
  subjectId: string;
  sourceUploadIds: string[];
  blueprintItems: BlueprintItemConfig[];
}

export interface BlueprintItemConfig {
  sequence: number;
  outcomeId: string | null;
  questionType: QuestionType;
  difficulty: Difficulty;
  cognitiveLevel: string | null;
  topicHint: string | null;
  sourceUploadId: string | null;
}

// ---- Store input types ----

export interface CreateAssessmentInput {
  workspaceId: string;
  creatorUserId: string;
  title: string;
  idempotencyKey?: string | null;
}

export interface UpdateAssessmentInput {
  id: string;
  workspaceId: string;
  status?: AssessmentStatus;
  currentVersion?: number;
  title?: string;
}

export interface CreateAssessmentVersionInput {
  assessmentId: string;
  workspaceId: string;
  version: number;
  configSnapshot: AssessmentConfigSnapshot;
}

export interface CreateBlueprintItemInput {
  assessmentVersionId: string;
  workspaceId: string;
  sequence: number;
  curriculumVersionId?: string | null;
  outcomeId?: string | null;
  subjectId?: string | null;
  gradeId?: string | null;
  questionType: QuestionType;
  difficulty: Difficulty;
  cognitiveLevel?: string | null;
  topicHint?: string | null;
  sourceUploadId?: string | null;
}

// ---- Store contracts ----

export interface AssessmentsStore {
  createAssessment(input: CreateAssessmentInput): Promise<Assessment>;
  getAssessmentById(workspaceId: string, id: string): Promise<Assessment | null>;
  getAssessmentByIdempotencyKey(
    workspaceId: string,
    key: string,
  ): Promise<Assessment | null>;
  listAssessments(
    workspaceId: string,
    options: { limit: number; cursor?: string },
  ): Promise<Assessment[]>;
  updateAssessment(input: UpdateAssessmentInput): Promise<Assessment>;

  createAssessmentVersion(input: CreateAssessmentVersionInput): Promise<AssessmentVersion>;
  getLatestVersion(
    workspaceId: string,
    assessmentId: string,
  ): Promise<AssessmentVersion | null>;
  getVersionByNumber(
    workspaceId: string,
    assessmentId: string,
    version: number,
  ): Promise<AssessmentVersion | null>;

  createBlueprintItems(inputs: CreateBlueprintItemInput[]): Promise<BlueprintItem[]>;
  listBlueprintItems(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<BlueprintItem[]>;
}
