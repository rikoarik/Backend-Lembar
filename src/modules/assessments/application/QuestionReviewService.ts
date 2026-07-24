/**
 * B4-01 — Question review, edit, and audit service.
 * B4-02 — Targeted question regeneration (candidate management).
 * B4-03 — Optimistic conflict handling via ETag.
 * B4-04 — Immutable finalization guard.
 *
 * Responsibilities:
 * - Import generated questions into the review layer.
 * - Edit a reviewed question (versioned, increments version + etag).
 * - Change status: accept / reject.
 * - Delete a reviewed question (audit + hard delete).
 * - Create regeneration candidates (B4-02): original preserved until candidate accepted.
 * - Optimistic locking via ETag (B4-03): editQuestion checks expectedEtag.
 * - Finalization guard (B4-04): rejects edits on finalized questions.
 * - Maintain an immutable append-only audit log for every state change.
 *
 * Source integrity: sourceIds from GeneratedQuestion are NEVER modified by edits.
 * Tenant isolation: every method requires workspaceId.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { GeneratedQuestion } from '../domain/QuestionGeneration.js';
import type {
  EditReviewedQuestionInput,
  QuestionAuditEntry,
  QuestionReviewStatus,
  QuestionReviewStore,
  ReviewedQuestion,
} from '../domain/QuestionReview.js';

// ---- Domain errors ----

export class QuestionNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Reviewed question ${id} not found`);
    this.name = 'QuestionNotFoundError';
  }
}

export class QuestionEtagMismatchError extends Error {
  constructor(
    public readonly questionId: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `ETag mismatch for question ${questionId}: expected "${expected}", got "${actual}"`,
    );
    this.name = 'QuestionEtagMismatchError';
  }
}

export class QuestionFinalizedError extends Error {
  constructor(public readonly questionId: string) {
    super(`Question ${questionId} belongs to a finalized assessment version and cannot be edited`);
    this.name = 'QuestionFinalizedError';
  }
}

export class QuestionNoCandidateError extends Error {
  constructor(public readonly questionId: string) {
    super(`Question ${questionId} has no pending candidate to accept or reject`);
    this.name = 'QuestionNoCandidateError';
  }
}

export class QuestionsPendingError extends Error {
  constructor(public readonly assessmentVersionId: string, public readonly count: number) {
    super(
      `Assessment version ${assessmentVersionId} has ${count} question(s) not yet accepted`,
    );
    this.name = 'QuestionsPendingError';
  }
}

export class AssessmentVersionNotFinalizedError extends Error {
  constructor(public readonly assessmentVersionId: string) {
    super(`Assessment version ${assessmentVersionId} is not finalized`);
    this.name = 'AssessmentVersionNotFinalizedError';
  }
}

// ---- ETag ----

export function computeEtag(questionId: string, version: number): string {
  return createHash('sha256')
    .update(`${questionId}:${version}`)
    .digest('hex')
    .slice(0, 32);
}

// ---- Service ----

export interface QuestionReviewServiceOptions {
  store: QuestionReviewStore;
  clock?: () => Date;
  id?: () => string;
}

export class QuestionReviewService {
  private readonly clock: () => Date;
  private readonly id: () => string;

  constructor(private readonly options: QuestionReviewServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  /**
   * Import a GeneratedQuestion into the review layer.
   * Idempotent: if a ReviewedQuestion already exists for this originalQuestionId, returns it.
   */
  async importQuestion(
    generatedQuestion: GeneratedQuestion,
    actorUserId: string,
  ): Promise<ReviewedQuestion> {
    const existing = await this.options.store.findByOriginalId(
      generatedQuestion.workspaceId,
      generatedQuestion.id,
    );
    if (existing) return existing;

    const id = this.id();
    const now = this.clock().toISOString();
    const version = 1;
    const reviewed: ReviewedQuestion = {
      id,
      originalQuestionId: generatedQuestion.id,
      assessmentVersionId: generatedQuestion.assessmentVersionId,
      workspaceId: generatedQuestion.workspaceId,
      blueprintSequence: generatedQuestion.blueprintSequence,
      questionType: generatedQuestion.questionType,
      difficulty: generatedQuestion.difficulty,
      stem: generatedQuestion.stem,
      options: generatedQuestion.options.map((o) => ({ ...o })),
      answer: generatedQuestion.answer,
      explanation: generatedQuestion.explanation,
      sourceIds: [...generatedQuestion.sourceIds],
      status: 'pending',
      version,
      etag: computeEtag(id, version),
      candidateId: null,
      isFinalized: false,
      createdAt: now,
      updatedAt: now,
    };

    const saved = await this.options.store.save(reviewed);
    await this.appendAudit({
      action: 'created',
      reviewed: saved,
      previous: null,
      actorUserId,
    });
    return saved;
  }

  /**
   * Edit a reviewed question.
   * B4-01: Increments version + recomputes etag. sourceIds preserved.
   * B4-03: If edits.expectedEtag is set, throws QuestionEtagMismatchError if stale.
   * B4-04: Throws QuestionFinalizedError if the question is finalized.
   */
  async editQuestion(
    workspaceId: string,
    reviewedQuestionId: string,
    edits: EditReviewedQuestionInput,
    actorUserId: string,
  ): Promise<ReviewedQuestion> {
    const existing = await this.options.store.findById(workspaceId, reviewedQuestionId);
    if (!existing) {
      throw new QuestionNotFoundError(reviewedQuestionId);
    }

    // B4-04: block edits on finalized questions
    if (existing.isFinalized) {
      throw new QuestionFinalizedError(reviewedQuestionId);
    }

    // B4-03: optimistic concurrency check
    if (edits.expectedEtag !== undefined && edits.expectedEtag !== existing.etag) {
      throw new QuestionEtagMismatchError(reviewedQuestionId, edits.expectedEtag, existing.etag);
    }

    const now = this.clock().toISOString();
    const newVersion = existing.version + 1;
    const updated: ReviewedQuestion = {
      ...existing,
      stem: edits.stem ?? existing.stem,
      options: edits.options ?? existing.options.map((o) => ({ ...o })),
      answer: edits.answer ?? existing.answer,
      explanation: edits.explanation ?? existing.explanation,
      difficulty: edits.difficulty ?? existing.difficulty,
      // sourceIds are NEVER modified
      sourceIds: [...existing.sourceIds],
      // if status explicitly set via edit, use it; otherwise keep existing
      status: edits.status ?? existing.status,
      version: newVersion,
      etag: computeEtag(existing.id, newVersion),
      updatedAt: now,
    };

    const saved = await this.options.store.save(updated);
    await this.appendAudit({
      action: 'edited',
      reviewed: saved,
      previous: existing,
      actorUserId,
    });
    return saved;
  }

  /**
   * Change the status of a reviewed question (accept or reject).
   * B4-04: Throws QuestionFinalizedError if the question is already finalized.
   */
  async setStatus(
    workspaceId: string,
    reviewedQuestionId: string,
    status: QuestionReviewStatus,
    actorUserId: string,
  ): Promise<ReviewedQuestion> {
    const existing = await this.options.store.findById(workspaceId, reviewedQuestionId);
    if (!existing) {
      throw new QuestionNotFoundError(reviewedQuestionId);
    }

    if (existing.isFinalized) {
      throw new QuestionFinalizedError(reviewedQuestionId);
    }

    const now = this.clock().toISOString();
    const newVersion = existing.version + 1;
    const updated: ReviewedQuestion = {
      ...existing,
      sourceIds: [...existing.sourceIds],
      options: existing.options.map((o) => ({ ...o })),
      status,
      version: newVersion,
      etag: computeEtag(existing.id, newVersion),
      updatedAt: now,
    };

    const saved = await this.options.store.save(updated);
    const action = status === 'accepted' ? 'accepted' : 'rejected';
    await this.appendAudit({ action, reviewed: saved, previous: existing, actorUserId });
    return saved;
  }

  /**
   * Delete a reviewed question. Appends a 'deleted' audit entry then removes.
   */
  async deleteQuestion(
    workspaceId: string,
    reviewedQuestionId: string,
    actorUserId: string,
  ): Promise<void> {
    const existing = await this.options.store.findById(workspaceId, reviewedQuestionId);
    if (!existing) {
      throw new QuestionNotFoundError(reviewedQuestionId);
    }

    if (existing.isFinalized) {
      throw new QuestionFinalizedError(reviewedQuestionId);
    }

    await this.appendAudit({
      action: 'deleted',
      reviewed: existing,
      previous: existing,
      actorUserId,
    });
    await this.options.store.delete(workspaceId, reviewedQuestionId);
  }

  /**
   * Get a single reviewed question by id.
   */
  async getQuestion(workspaceId: string, reviewedQuestionId: string): Promise<ReviewedQuestion> {
    const q = await this.options.store.findById(workspaceId, reviewedQuestionId);
    if (!q) {
      throw new QuestionNotFoundError(reviewedQuestionId);
    }
    return q;
  }

  /**
   * List all reviewed questions for an assessment version.
   */
  async listQuestions(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<ReviewedQuestion[]> {
    return this.options.store.listByAssessmentVersion(workspaceId, assessmentVersionId);
  }

  /**
   * Get audit log for a single reviewed question.
   */
  async getAuditLog(
    workspaceId: string,
    reviewedQuestionId: string,
  ): Promise<QuestionAuditEntry[]> {
    return this.options.store.getAuditLog(workspaceId, reviewedQuestionId);
  }

  /**
   * Get full audit log for an assessment version.
   */
  async getAssessmentAuditLog(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<QuestionAuditEntry[]> {
    return this.options.store.getAssessmentAuditLog(workspaceId, assessmentVersionId);
  }

  // ── B4-02: Candidate management ─────────────────────────────────────────

  /**
   * Create a candidate replacement for a question.
   * Idempotent: if candidateId is already set, returns existing candidate.
   * The original question is preserved and remains active until candidate is accepted.
   *
   * For simplicity in this in-memory implementation, the "candidate" is a new
   * ReviewedQuestion with the same fields as the original (content would normally
   * come from an AI regeneration call). The original has candidateId set to point
   * to the new candidate.
   */
  async createCandidate(
    workspaceId: string,
    originalQuestionId: string,
    actorUserId: string,
    idempotencyKey?: string,
  ): Promise<{ original: ReviewedQuestion; candidate: ReviewedQuestion; created: boolean }> {
    const original = await this.options.store.findById(workspaceId, originalQuestionId);
    if (!original) {
      throw new QuestionNotFoundError(originalQuestionId);
    }

    if (original.isFinalized) {
      throw new QuestionFinalizedError(originalQuestionId);
    }

    // Idempotent: if already has a candidate, return it
    if (original.candidateId) {
      const existing = await this.options.store.findById(workspaceId, original.candidateId);
      if (existing) {
        return { original, candidate: existing, created: false };
      }
    }

    // Create the candidate as a copy with a new id
    // In production, this would call the AI to regenerate.
    // The idempotencyKey prevents double-creation across retries.
    void idempotencyKey; // tracked for future use with a persistent store

    const candidateId = this.id();
    const now = this.clock().toISOString();
    const candidateVersion = 1;
    const candidate: ReviewedQuestion = {
      id: candidateId,
      originalQuestionId: original.originalQuestionId,
      assessmentVersionId: original.assessmentVersionId,
      workspaceId: original.workspaceId,
      blueprintSequence: original.blueprintSequence,
      questionType: original.questionType,
      difficulty: original.difficulty,
      stem: original.stem, // actual regeneration would replace this
      options: original.options.map((o) => ({ ...o })),
      answer: original.answer,
      explanation: original.explanation,
      sourceIds: [...original.sourceIds],
      status: 'pending',
      version: candidateVersion,
      etag: computeEtag(candidateId, candidateVersion),
      candidateId: null,
      isFinalized: false,
      createdAt: now,
      updatedAt: now,
    };

    await this.options.store.save(candidate);

    // Update original to point to candidate
    const updatedOriginal: ReviewedQuestion = {
      ...original,
      sourceIds: [...original.sourceIds],
      options: original.options.map((o) => ({ ...o })),
      candidateId,
      updatedAt: now,
    };
    const savedOriginal = await this.options.store.save(updatedOriginal);

    await this.appendAudit({
      action: 'candidate_created',
      reviewed: savedOriginal,
      previous: original,
      actorUserId,
    });

    return { original: savedOriginal, candidate, created: true };
  }

  /**
   * Accept the candidate: swap candidate content into the original question slot,
   * delete the candidate record, clear candidateId.
   */
  async acceptCandidate(
    workspaceId: string,
    originalQuestionId: string,
    actorUserId: string,
  ): Promise<ReviewedQuestion> {
    const original = await this.options.store.findById(workspaceId, originalQuestionId);
    if (!original) {
      throw new QuestionNotFoundError(originalQuestionId);
    }

    if (!original.candidateId) {
      throw new QuestionNoCandidateError(originalQuestionId);
    }

    const candidate = await this.options.store.findById(workspaceId, original.candidateId);
    if (!candidate) {
      throw new QuestionNoCandidateError(originalQuestionId);
    }

    const now = this.clock().toISOString();
    const newVersion = original.version + 1;

    // Merge candidate content into original
    const accepted: ReviewedQuestion = {
      ...original,
      stem: candidate.stem,
      options: candidate.options.map((o) => ({ ...o })),
      answer: candidate.answer,
      explanation: candidate.explanation,
      sourceIds: [...original.sourceIds], // source integrity: keep original sources
      status: 'accepted',
      version: newVersion,
      etag: computeEtag(original.id, newVersion),
      candidateId: null,
      updatedAt: now,
    };

    const saved = await this.options.store.save(accepted);

    // Delete the candidate record
    await this.options.store.delete(workspaceId, candidate.id);

    await this.appendAudit({
      action: 'candidate_accepted',
      reviewed: saved,
      previous: original,
      actorUserId,
    });

    return saved;
  }

  /**
   * Reject the candidate: delete it and clear candidateId on the original.
   */
  async rejectCandidate(
    workspaceId: string,
    originalQuestionId: string,
    actorUserId: string,
  ): Promise<ReviewedQuestion> {
    const original = await this.options.store.findById(workspaceId, originalQuestionId);
    if (!original) {
      throw new QuestionNotFoundError(originalQuestionId);
    }

    if (!original.candidateId) {
      throw new QuestionNoCandidateError(originalQuestionId);
    }

    const candidateId = original.candidateId;
    const now = this.clock().toISOString();

    const restored: ReviewedQuestion = {
      ...original,
      sourceIds: [...original.sourceIds],
      options: original.options.map((o) => ({ ...o })),
      candidateId: null,
      updatedAt: now,
    };

    const saved = await this.options.store.save(restored);

    // Delete candidate
    await this.options.store.delete(workspaceId, candidateId);

    await this.appendAudit({
      action: 'candidate_rejected',
      reviewed: saved,
      previous: original,
      actorUserId,
    });

    return saved;
  }

  // ── B4-04: Finalization ──────────────────────────────────────────────────

  /**
   * Validate that all questions in an assessment version are accepted.
   * Throws QuestionsPendingError if any are not.
   */
  async validateAllAccepted(workspaceId: string, assessmentVersionId: string): Promise<void> {
    const questions = await this.options.store.listByAssessmentVersion(
      workspaceId,
      assessmentVersionId,
    );
    const pending = questions.filter((q) => q.status !== 'accepted');
    if (pending.length > 0) {
      throw new QuestionsPendingError(assessmentVersionId, pending.length);
    }
  }

  /**
   * Mark all questions in an assessment version as finalized (immutable).
   * Called by FinalizationService after validation passes.
   */
  async markAllFinalized(workspaceId: string, assessmentVersionId: string): Promise<void> {
    await this.options.store.markAllFinalized(workspaceId, assessmentVersionId);
  }

  private async appendAudit(params: {
    action: QuestionAuditEntry['action'];
    reviewed: ReviewedQuestion;
    previous: ReviewedQuestion | null;
    actorUserId: string;
  }): Promise<void> {
    const entry: QuestionAuditEntry = {
      id: this.id(),
      reviewedQuestionId: params.reviewed.id,
      assessmentVersionId: params.reviewed.assessmentVersionId,
      workspaceId: params.reviewed.workspaceId,
      action: params.action,
      previousSnapshot: params.previous,
      nextSnapshot: params.reviewed,
      actorUserId: params.actorUserId,
      createdAt: this.clock().toISOString(),
    };
    await this.options.store.appendAudit(entry);
  }
}
