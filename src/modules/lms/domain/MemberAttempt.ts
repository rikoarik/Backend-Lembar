/**
 * LMS-B — MemberAttempt domain types.
 *
 * A MemberAttempt records one workspace member's attempt at an assessment.
 * Workspace-scoped: all reads/writes require workspaceId.
 */

export interface MemberAttempt {
  id: string;
  assessmentId: string;
  workspaceId: string;
  memberId: string;
  /** Map of questionId → answer string. Empty until submitted. */
  answers: Record<string, string>;
  startedAt: string;
  submittedAt?: string;
}

// ---- Store contract ----

export interface MemberAttemptStore {
  save(attempt: MemberAttempt): Promise<MemberAttempt>;
  findById(id: string): Promise<MemberAttempt | null>;
  findByMember(workspaceId: string, memberId: string): Promise<MemberAttempt[]>;
  findByAssessment(workspaceId: string, assessmentId: string): Promise<MemberAttempt[]>;
}
