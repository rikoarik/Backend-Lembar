/**
 * B4-01..B4-04 — In-memory implementation of QuestionReviewStore.
 *
 * Used by unit and integration tests. Mirrors the DB contract exactly.
 */
import { randomUUID } from 'node:crypto';

import type {
  AssessmentFinalization,
  QuestionAuditEntry,
  QuestionReviewStore,
  ReviewedQuestion,
} from '../domain/QuestionReview.js';

void randomUUID; // available if needed by subclasses

export class InMemoryQuestionReviewStore implements QuestionReviewStore {
  private readonly questions = new Map<string, ReviewedQuestion>();
  private readonly audit: QuestionAuditEntry[] = [];
  private readonly finalizations = new Map<string, AssessmentFinalization>();

  async save(question: ReviewedQuestion): Promise<ReviewedQuestion> {
    const copy = deepCopyQuestion(question);
    this.questions.set(question.id, copy);
    return deepCopyQuestion(copy);
  }

  async findById(workspaceId: string, id: string): Promise<ReviewedQuestion | null> {
    const q = this.questions.get(id);
    if (!q || q.workspaceId !== workspaceId) return null;
    return deepCopyQuestion(q);
  }

  async findByOriginalId(
    workspaceId: string,
    originalQuestionId: string,
  ): Promise<ReviewedQuestion | null> {
    for (const q of this.questions.values()) {
      if (
        q.workspaceId === workspaceId &&
        q.originalQuestionId === originalQuestionId &&
        q.candidateId === null // only return the "active" question, not a candidate
      ) {
        return deepCopyQuestion(q);
      }
    }
    return null;
  }

  async listByAssessmentVersion(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<ReviewedQuestion[]> {
    return Array.from(this.questions.values())
      .filter(
        (q) =>
          q.workspaceId === workspaceId &&
          q.assessmentVersionId === assessmentVersionId &&
          // exclude candidate records from the main list
          !this.isCandidateOf(q.id),
      )
      .map(deepCopyQuestion)
      .sort((a, b) => a.blueprintSequence - b.blueprintSequence);
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    const q = this.questions.get(id);
    if (q && q.workspaceId === workspaceId) {
      this.questions.delete(id);
    }
  }

  async appendAudit(entry: QuestionAuditEntry): Promise<QuestionAuditEntry> {
    const copy = { ...entry };
    this.audit.push(copy);
    return { ...copy };
  }

  async getAuditLog(
    workspaceId: string,
    reviewedQuestionId: string,
  ): Promise<QuestionAuditEntry[]> {
    return this.audit
      .filter(
        (e) => e.workspaceId === workspaceId && e.reviewedQuestionId === reviewedQuestionId,
      )
      .map((e) => ({ ...e }));
  }

  async getAssessmentAuditLog(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<QuestionAuditEntry[]> {
    return this.audit
      .filter(
        (e) => e.workspaceId === workspaceId && e.assessmentVersionId === assessmentVersionId,
      )
      .map((e) => ({ ...e }));
  }

  // ── B4-04: Finalization ────────────────────────────────────────────────────

  async saveFinalization(record: AssessmentFinalization): Promise<AssessmentFinalization> {
    const copy = { ...record };
    this.finalizations.set(`${record.workspaceId}:${record.assessmentVersionId}`, copy);
    return { ...copy };
  }

  async getFinalization(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<AssessmentFinalization | null> {
    const key = `${workspaceId}:${assessmentVersionId}`;
    const rec = this.finalizations.get(key);
    return rec ? { ...rec } : null;
  }

  async markAllFinalized(workspaceId: string, assessmentVersionId: string): Promise<void> {
    for (const [id, q] of this.questions.entries()) {
      if (q.workspaceId === workspaceId && q.assessmentVersionId === assessmentVersionId) {
        this.questions.set(id, { ...q, isFinalized: true, options: q.options.map((o) => ({ ...o })), sourceIds: [...q.sourceIds] });
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Returns true if any question has this id as its candidateId */
  private isCandidateOf(id: string): boolean {
    for (const q of this.questions.values()) {
      if (q.candidateId === id) return true;
    }
    return false;
  }

  /** Test helper: reset all state */
  reset(): void {
    this.questions.clear();
    this.audit.length = 0;
    this.finalizations.clear();
  }
}

function deepCopyQuestion(q: ReviewedQuestion): ReviewedQuestion {
  return {
    ...q,
    options: q.options.map((o) => ({ ...o })),
    sourceIds: [...q.sourceIds],
  };
}
