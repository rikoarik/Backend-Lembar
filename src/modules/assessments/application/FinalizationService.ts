/**
 * B4-04 — Immutable finalization service.
 *
 * Responsibilities:
 * - Validate all questions in an assessment version are accepted.
 * - Set the immutable finalized flag on all questions.
 * - Record finalization in the store (idempotent).
 *
 * After finalization:
 * - No edits allowed (QuestionFinalizedError → 403)
 * - Re-finalization is idempotent (returns existing finalization record)
 *
 * Tenant isolation: every method requires workspaceId.
 */
import { randomUUID } from 'node:crypto';

import type { AssessmentFinalization, QuestionReviewStore } from '../domain/QuestionReview.js';
import {
  QuestionsPendingError,
  QuestionReviewService,
} from './QuestionReviewService.js';

export interface FinalizationServiceOptions {
  store: QuestionReviewStore;
  reviewService: QuestionReviewService;
  clock?: () => Date;
  id?: () => string;
}

export interface FinalizeResult {
  finalization: AssessmentFinalization;
  /** true if this call actually finalized; false if already finalized (idempotent) */
  alreadyFinalized: boolean;
}

export class FinalizationService {
  private readonly clock: () => Date;
  private readonly id: () => string;

  constructor(private readonly options: FinalizationServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  /**
   * Finalize an assessment version.
   *
   * Idempotent: if already finalized, returns the existing record with alreadyFinalized=true.
   * Precondition: all questions must be in 'accepted' status.
   * Postcondition: all questions have isFinalized=true; no further edits are allowed.
   *
   * @throws QuestionsPendingError if any question is not accepted
   */
  async finalizeAssessmentVersion(
    workspaceId: string,
    assessmentVersionId: string,
    actorUserId: string,
  ): Promise<FinalizeResult> {
    // Idempotency: if already finalized, return existing record
    const existing = await this.options.store.getFinalization(workspaceId, assessmentVersionId);
    if (existing) {
      return { finalization: existing, alreadyFinalized: true };
    }

    // Validate all questions are accepted
    await this.options.reviewService.validateAllAccepted(workspaceId, assessmentVersionId);

    // Mark all questions as finalized
    await this.options.reviewService.markAllFinalized(workspaceId, assessmentVersionId);

    // Record finalization
    const record: AssessmentFinalization = {
      id: this.id(),
      assessmentVersionId,
      workspaceId,
      finalizedBy: actorUserId,
      finalizedAt: this.clock().toISOString(),
    };

    const saved = await this.options.store.saveFinalization(record);
    return { finalization: saved, alreadyFinalized: false };
  }

  /**
   * Check if an assessment version is finalized.
   */
  async isFinalized(workspaceId: string, assessmentVersionId: string): Promise<boolean> {
    const record = await this.options.store.getFinalization(workspaceId, assessmentVersionId);
    return record !== null;
  }

  /**
   * Get finalization record for an assessment version.
   */
  async getFinalization(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<AssessmentFinalization | null> {
    return this.options.store.getFinalization(workspaceId, assessmentVersionId);
  }
}
