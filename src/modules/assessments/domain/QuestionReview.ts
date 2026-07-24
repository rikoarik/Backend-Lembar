/**
 * B4-01 — Domain types for question review, edit, and audit.
 * B4-02 — Candidate regeneration types.
 * B4-03 — ETag for optimistic concurrency.
 * B4-04 — Finalization types.
 *
 * Key invariants:
 * - ReviewedQuestion.version increments on every edit.
 * - status: 'pending' | 'accepted' | 'rejected' — only 'accepted' clears for finalization.
 * - sourceIntegrity: the original sourceIds from GeneratedQuestion are preserved.
 * - Every state change is written to an immutable audit log.
 * - Tenant isolation: all reads/writes require workspaceId.
 */

import type { QuestionType, Difficulty } from './Assessment.js';
import type { QuestionOption } from './QuestionGeneration.js';

// ---- Review status ----

export type QuestionReviewStatus = 'pending' | 'accepted' | 'rejected';

// ---- Reviewed question ----

export interface ReviewedQuestion {
  id: string;
  /** FK to GeneratedQuestion.id — the original AI-generated question */
  originalQuestionId: string;
  assessmentVersionId: string;
  workspaceId: string;
  blueprintSequence: number;
  questionType: QuestionType;
  difficulty: Difficulty;
  stem: string;
  options: QuestionOption[];
  answer: string;
  explanation: string;
  /** Original source IDs from GeneratedQuestion — preserved for integrity */
  sourceIds: string[];
  status: QuestionReviewStatus;
  /** Monotonically incremented on every edit */
  version: number;
  /** ETag computed from version (used for optimistic concurrency in B4-03) */
  etag: string;
  /**
   * B4-02: If non-null, a candidate replacement is pending.
   * The original question remains active until candidate is accepted.
   */
  candidateId: string | null;
  /** B4-04: Set to true when the assessment version is finalized */
  isFinalized: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---- Audit log ----

export type QuestionAuditAction =
  | 'created'
  | 'edited'
  | 'accepted'
  | 'rejected'
  | 'deleted'
  | 'candidate_created'
  | 'candidate_accepted'
  | 'candidate_rejected'
  | 'finalized';

export interface QuestionAuditEntry {
  id: string;
  reviewedQuestionId: string;
  assessmentVersionId: string;
  workspaceId: string;
  action: QuestionAuditAction;
  /** JSON snapshot of the ReviewedQuestion before the change */
  previousSnapshot: ReviewedQuestion | null;
  /** JSON snapshot after the change */
  nextSnapshot: ReviewedQuestion | null;
  /** Actor performing the action */
  actorUserId: string;
  createdAt: string;
}

// ---- Store input types ----

export interface CreateReviewedQuestionInput {
  id: string;
  originalQuestionId: string;
  assessmentVersionId: string;
  workspaceId: string;
  blueprintSequence: number;
  questionType: QuestionType;
  difficulty: Difficulty;
  stem: string;
  options: QuestionOption[];
  answer: string;
  explanation: string;
  sourceIds: string[];
}

export interface EditReviewedQuestionInput {
  stem?: string;
  options?: QuestionOption[];
  answer?: string;
  explanation?: string;
  difficulty?: Difficulty;
  /** Set status directly (accept/reject via PATCH body) */
  status?: QuestionReviewStatus;
  /** B4-03: if set, update is rejected if current etag differs */
  expectedEtag?: string;
}

// ---- Finalization record ----

export interface AssessmentFinalization {
  id: string;
  assessmentVersionId: string;
  workspaceId: string;
  finalizedBy: string;
  finalizedAt: string;
}

// ---- Store contract ----

export interface QuestionReviewStore {
  save(question: ReviewedQuestion): Promise<ReviewedQuestion>;
  findById(workspaceId: string, id: string): Promise<ReviewedQuestion | null>;
  /** Find by originalQuestionId + assessmentVersionId. */
  findByOriginalId(workspaceId: string, originalQuestionId: string): Promise<ReviewedQuestion | null>;
  /** List all reviewed questions for an assessment version. */
  listByAssessmentVersion(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<ReviewedQuestion[]>;
  /** Hard-delete a reviewed question. */
  delete(workspaceId: string, id: string): Promise<void>;

  /** Append an audit entry. */
  appendAudit(entry: QuestionAuditEntry): Promise<QuestionAuditEntry>;
  /** Retrieve audit log for a reviewed question. */
  getAuditLog(
    workspaceId: string,
    reviewedQuestionId: string,
  ): Promise<QuestionAuditEntry[]>;
  /** Retrieve full audit log for an assessment version. */
  getAssessmentAuditLog(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<QuestionAuditEntry[]>;

  /** B4-04: Save finalization record. Idempotent. */
  saveFinalization(record: AssessmentFinalization): Promise<AssessmentFinalization>;
  /** B4-04: Get finalization record for an assessment version. */
  getFinalization(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<AssessmentFinalization | null>;
  /** B4-04: Mark all questions in an assessment version as finalized. */
  markAllFinalized(workspaceId: string, assessmentVersionId: string): Promise<void>;
}
