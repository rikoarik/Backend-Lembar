/**
 * LMS-A — In-memory AttemptStore.
 * ponytail: swap for DrizzleAttemptStore when lms DB migration lands.
 */
import { randomUUID } from 'node:crypto';

import type { AttemptStore, GuestAttempt } from '../domain/Attempt.js';

export class InMemoryAttemptStore implements AttemptStore {
  private readonly store = new Map<string, GuestAttempt>();

  async save(attempt: GuestAttempt): Promise<GuestAttempt> {
    const record: GuestAttempt = attempt.id
      ? { ...attempt }
      : { ...attempt, id: randomUUID() };
    this.store.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<GuestAttempt | null> {
    return this.store.get(id) ?? null;
  }

  async findByAssessment(assessmentId: string): Promise<GuestAttempt[]> {
    return [...this.store.values()].filter((a) => a.assessmentId === assessmentId);
  }

  async findAll(_workspaceId?: string): Promise<GuestAttempt[]> {
    // ponytail: workspaceId filtering when GuestAttempt gains a workspaceId field
    return [...this.store.values()];
  }
}
