/**
 * LMS-B — In-memory MemberAttemptStore.
 * Used by unit tests; mirrors the store contract in domain/MemberAttempt.ts.
 */
import { randomUUID } from 'node:crypto';

import type { MemberAttempt, MemberAttemptStore } from '../domain/MemberAttempt.js';

export class InMemoryMemberAttemptStore implements MemberAttemptStore {
  private readonly store = new Map<string, MemberAttempt>();

  async save(attempt: MemberAttempt): Promise<MemberAttempt> {
    const copy = { ...attempt };
    this.store.set(copy.id, copy);
    return { ...copy };
  }

  async findById(id: string): Promise<MemberAttempt | null> {
    return this.store.has(id) ? { ...this.store.get(id)! } : null;
  }

  async findByMember(workspaceId: string, memberId: string): Promise<MemberAttempt[]> {
    return [...this.store.values()]
      .filter((a) => a.workspaceId === workspaceId && a.memberId === memberId)
      .map((a) => ({ ...a }));
  }

  async findByAssessment(workspaceId: string, assessmentId: string): Promise<MemberAttempt[]> {
    return [...this.store.values()]
      .filter((a) => a.workspaceId === workspaceId && a.assessmentId === assessmentId)
      .map((a) => ({ ...a }));
  }

  /** Convenience for tests: create a new attempt and persist it. */
  async create(input: Omit<MemberAttempt, 'id' | 'answers' | 'startedAt'>): Promise<MemberAttempt> {
    const attempt: MemberAttempt = {
      id: randomUUID(),
      answers: {},
      startedAt: new Date().toISOString(),
      ...input,
    };
    return this.save(attempt);
  }
}
