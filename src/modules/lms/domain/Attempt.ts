/**
 * LMS-A — Guest attempt session domain types.
 *
 * Lifecycle: started → submitted (submittedAt set, answers frozen)
 * ponytail: no authenticated student attempt type yet; add StudentAttempt when auth-scoped LMS tasks land.
 */

export interface GuestAttempt {
  id: string;
  assessmentId: string;
  guestName: string;
  guestClass?: string;
  startedAt: string;
  /** Map of questionId → answer text/choice */
  answers: Record<string, string>;
  submittedAt?: string;
}

export interface AttemptStore {
  save(attempt: GuestAttempt): Promise<GuestAttempt>;
  findById(id: string): Promise<GuestAttempt | null>;
  findByAssessment(assessmentId: string): Promise<GuestAttempt[]>;
}
