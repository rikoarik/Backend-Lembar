/**
 * LMS-A + LMS-B — AttemptService.
 *
 * LMS-A: guest attempt — unauthenticated, assessment-scoped.
 * LMS-B: member attempt — authenticated, workspace-scoped.
 *
 * Constructor overloads:
 *   new AttemptService(guestStore)          — LMS-A only (used in tests)
 *   new AttemptService(deps)                — LMS-A + LMS-B combined
 */
import { randomUUID } from 'node:crypto';

import { ApiError } from '../../../common/errors/envelope.js';
import type {
  AttemptStore,
  GradedAnswer,
  GradingQuestion,
  GradingResult,
  GuestAttempt,
} from '../domain/Attempt.js';
import type { MemberAttempt, MemberAttemptStore } from '../domain/MemberAttempt.js';

/** LMS-A only (guest) */
export interface GuestAttemptServiceDeps {
  guestStore: AttemptStore;
}

/** LMS-B only (member) */
export interface MemberAttemptServiceDeps {
  store: MemberAttemptStore;
}

/** LMS-A + LMS-B combined */
export interface CombinedAttemptServiceDeps {
  guestStore: AttemptStore;
  memberStore: MemberAttemptStore;
}

export type AttemptServiceDeps =
  | GuestAttemptServiceDeps
  | MemberAttemptServiceDeps
  | CombinedAttemptServiceDeps;

export class AttemptService {
  private readonly guestStore: AttemptStore;
  private readonly memberStore: MemberAttemptStore | null;

  constructor(deps: AttemptServiceDeps) {
    if ('save' in deps) {
      // Legacy: raw AttemptStore passed directly (LMS-A test convenience)
      this.guestStore = deps as unknown as AttemptStore;
      this.memberStore = null;
    } else if ('store' in deps) {
      // LMS-B only: { store: MemberAttemptStore }
      this.guestStore = deps.store as unknown as AttemptStore;
      this.memberStore = (deps as MemberAttemptServiceDeps).store;
    } else if ('memberStore' in deps) {
      // Combined LMS-A + LMS-B: { guestStore, memberStore }
      this.guestStore = (deps as CombinedAttemptServiceDeps).guestStore;
      this.memberStore = (deps as CombinedAttemptServiceDeps).memberStore;
    } else {
      // LMS-A only: { guestStore }
      this.guestStore = (deps as GuestAttemptServiceDeps).guestStore;
      this.memberStore = null;
    }
  }

  // ---- LMS-A: guest attempts ----

  async startGuestAttempt(
    assessmentId: string,
    guestName: string,
    guestClass?: string,
  ): Promise<GuestAttempt> {
    const base: GuestAttempt = {
      id: randomUUID(),
      assessmentId,
      guestName,
      startedAt: new Date().toISOString(),
      answers: {},
    };
    if (guestClass !== undefined) {
      return this.guestStore.save({ ...base, guestClass });
    }
    return this.guestStore.save(base);
  }

  async submitAttempt(
    id: string,
    answers: Record<string, string>,
    questions?: GradingQuestion[],
  ): Promise<GuestAttempt> {
    const existing = await this.guestStore.findById(id);
    if (!existing) {
      throw new Error(`Attempt not found: ${id}`);
    }
    const update: GuestAttempt = { ...existing, answers, submittedAt: new Date().toISOString() };
    if (questions !== undefined) {
      update.gradingResult = this.gradeAttempt(answers, questions);
    }
    return this.guestStore.save(update);
  }

  /** LMS-D: grade answers against question keys. MC/true_false are auto-graded; essay/short_answer → needs_review. */
  private gradeAttempt(
    answers: Record<string, string>,
    questions: GradingQuestion[],
  ): GradingResult {
    let totalScore = 0;
    const gradedAnswers: GradedAnswer[] = questions.map((q) => {
      const given = answers[q.questionId] ?? '';
      if (q.type === 'multiple_choice' || q.type === 'true_false') {
        const correct = given === (q.answerKey ?? '');
        const score = correct ? 1 : 0;
        totalScore += score;
        return { questionId: q.questionId, given, correct, score };
      }
      // essay | short_answer
      return { questionId: q.questionId, given, correct: 'needs_review' };
    });
    return { gradedAnswers, totalScore };
  }

  // ---- LMS-B: member attempts ----

  async startMemberAttempt(
    workspaceId: string,
    assessmentId: string,
    memberId: string,
  ): Promise<MemberAttempt> {
    if (!this.memberStore) {
      throw new ApiError({
        code: 'INTERNAL_ERROR',
        message: 'MemberAttemptStore not configured',
        requestId: 'unknown',
        status: 500,
      });
    }
    const attempt: MemberAttempt = {
      id: randomUUID(),
      workspaceId,
      assessmentId,
      memberId,
      answers: {},
      startedAt: new Date().toISOString(),
    };
    return this.memberStore.save(attempt);
  }

  async submitMemberAttempt(id: string, answers: Record<string, string>): Promise<MemberAttempt> {
    if (!this.memberStore) {
      throw new ApiError({
        code: 'INTERNAL_ERROR',
        message: 'MemberAttemptStore not configured',
        requestId: 'unknown',
        status: 500,
      });
    }
    const attempt = await this.memberStore.findById(id);
    if (!attempt) {
      throw new ApiError({
        code: 'RESOURCE_NOT_FOUND',
        message: 'Attempt tidak ditemukan.',
        requestId: 'unknown',
        status: 404,
      });
    }
    if (attempt.submittedAt) {
      throw new ApiError({
        code: 'STATE_CONFLICT',
        message: 'Attempt sudah pernah disubmit.',
        requestId: 'unknown',
        status: 409,
      });
    }
    return this.memberStore.save({ ...attempt, answers, submittedAt: new Date().toISOString() });
  }
}
