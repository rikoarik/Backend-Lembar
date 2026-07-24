/**
 * B7-03 — Teacher onboarding service.
 *
 * POST /v1/school/onboarding/complete — mark teacher as onboarded (idempotent)
 * GET  /v1/school/onboarding/status   — return current onboarding state
 *
 * Invariants:
 * - Status transitions: not_started → in_progress → completed
 * - complete() is idempotent: calling twice returns same result
 * - Only the teacher themselves can complete their own onboarding
 */
import type { OnboardingStatus, TeacherOnboardingRecord } from '../domain/types.js';

export interface TeacherOnboardingStore {
  findRecord(userId: string, workspaceId: string): Promise<TeacherOnboardingRecord | null>;
  upsertRecord(record: TeacherOnboardingRecord): Promise<TeacherOnboardingRecord>;
}

export class TeacherOnboardingService {
  constructor(
    private readonly store: TeacherOnboardingStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Mark teacher onboarding as completed. Idempotent — safe to call multiple times.
   * Returns the final onboarding record.
   */
  async completeOnboarding(
    userId: string,
    workspaceId: string,
  ): Promise<TeacherOnboardingRecord> {
    const existing = await this.store.findRecord(userId, workspaceId);
    const now = this.clock();

    // Already completed — idempotent: return existing record unchanged
    if (existing?.status === 'completed') {
      return existing;
    }

    const record: TeacherOnboardingRecord = {
      userId,
      workspaceId,
      status: 'completed',
      completedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    return this.store.upsertRecord(record);
  }

  /**
   * Get current onboarding status for a teacher in a workspace.
   * Returns a synthesised 'not_started' record if none exists yet.
   */
  async getStatus(userId: string, workspaceId: string): Promise<TeacherOnboardingRecord> {
    const existing = await this.store.findRecord(userId, workspaceId);
    if (existing) return existing;

    // Not yet started — return a virtual record (not persisted)
    return {
      userId,
      workspaceId,
      status: 'not_started',
      completedAt: null,
      updatedAt: this.clock().toISOString(),
    };
  }

  /**
   * Mark onboarding as in_progress. No-op if already in_progress or completed.
   */
  async startOnboarding(
    userId: string,
    workspaceId: string,
  ): Promise<TeacherOnboardingRecord> {
    const existing = await this.store.findRecord(userId, workspaceId);

    // Already progressed — do not regress
    if (existing && existing.status !== 'not_started') {
      return existing;
    }

    const now = this.clock();
    const record: TeacherOnboardingRecord = {
      userId,
      workspaceId,
      status: 'in_progress',
      completedAt: null,
      updatedAt: now.toISOString(),
    };

    return this.store.upsertRecord(record);
  }
}
