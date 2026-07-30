/**
 * LMS-A — Guest attempt session domain types.
 *
 * Lifecycle: started → submitted (submittedAt set, answers frozen)
 * ponytail: no authenticated student attempt type yet; add StudentAttempt when auth-scoped LMS tasks land.
 */

// ---- LMS-D: auto-grading types ----

/** Question descriptor passed to gradeAttempt; subset of the full Question domain (not yet built). */
export interface GradingQuestion {
  questionId: string;
  type: 'multiple_choice' | 'true_false' | 'essay' | 'short_answer';
  /** Required for multiple_choice and true_false; omit for open-ended types. */
  answerKey?: string;
}

/** Per-question grading result stored on a submitted attempt. */
export interface GradedAnswer {
  questionId: string;
  /** The raw answer string the student submitted. */
  given: string;
  /** true/false for auto-graded types; 'needs_review' for essay/short_answer. */
  correct: boolean | 'needs_review';
  /** Points awarded. Present for auto-graded (0 or 1); absent for needs_review. */
  score?: number;
}

/** Grading result stored on the attempt after submission with questions. */
export interface GradingResult {
  gradedAnswers: GradedAnswer[];
  /** Sum of scores for auto-graded questions only (needs_review excluded). */
  totalScore: number;
  /** Count of auto-gradeable questions (multiple_choice + true_false). */
  maxScore: number;
}

// ---- LMS-A: attempt types ----

export interface GuestAttempt {
  id: string;
  assessmentId: string;
  guestName: string;
  guestClass?: string;
  startedAt: string;
  /** Map of questionId → answer text/choice */
  answers: Record<string, string>;
  submittedAt?: string;
  /** Present only when submitAttempt is called with a questions array. */
  gradingResult?: GradingResult;
}

export interface AttemptStore {
  save(attempt: GuestAttempt): Promise<GuestAttempt>;
  findById(id: string): Promise<GuestAttempt | null>;
  findByAssessment(assessmentId: string): Promise<GuestAttempt[]>;
  /** LMS-E: return all attempts, optionally scoped by workspaceId (future). */
  findAll(workspaceId?: string): Promise<GuestAttempt[]>;
}
