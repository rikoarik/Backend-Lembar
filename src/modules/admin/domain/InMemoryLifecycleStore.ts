/**
 * B8-02 — In-memory implementation of LifecycleStore (untuk testing).
 */
import type { LifecycleStore, AccountRow, DeleteScheduleRow, TombstoneRow } from '../application/DataLifecycleService.js';

export class InMemoryLifecycleStore implements LifecycleStore {
  accounts = new Map<string, AccountRow>();
  schedules = new Map<string, DeleteScheduleRow>();
  tombstones = new Map<string, TombstoneRow>();

  private scheduleCounter = 1;
  private tombstoneCounter = 1;

  // ── Seed helpers ──────────────────────────────────────────────────────────

  seedAccount(account: AccountRow): void {
    this.accounts.set(account.id, { ...account });
  }

  // ── LifecycleStore impl ───────────────────────────────────────────────────

  async findAccount(id: string): Promise<AccountRow | null> {
    return this.accounts.get(id) ?? null;
  }

  async softDeleteAccount(id: string): Promise<void> {
    const acc = this.accounts.get(id);
    if (acc) {
      this.accounts.set(id, { ...acc, deletedAt: new Date() });
    }
  }

  async hardDeleteAccount(id: string): Promise<void> {
    this.accounts.delete(id);
  }

  async createDeleteSchedule(input: {
    accountId: string;
    scheduledBy: string;
    purgeAfter: Date;
    retentionDays: number;
    reason?: string;
  }): Promise<DeleteScheduleRow> {
    const id = `sched-${this.scheduleCounter++}`;
    const row: DeleteScheduleRow = {
      id,
      accountId: input.accountId,
      scheduledBy: input.scheduledBy,
      purgeAfter: input.purgeAfter,
      retentionDays: input.retentionDays,
      reason: input.reason ?? null,
      status: 'pending',
    };
    this.schedules.set(id, row);
    return row;
  }

  async findPendingSchedule(accountId: string): Promise<DeleteScheduleRow | null> {
    for (const row of this.schedules.values()) {
      if (row.accountId === accountId && row.status === 'pending') return row;
    }
    return null;
  }

  async cancelDeleteSchedule(id: string): Promise<void> {
    const row = this.schedules.get(id);
    if (row) this.schedules.set(id, { ...row, status: 'cancelled' });
  }

  async markScheduleExecuted(id: string): Promise<void> {
    const row = this.schedules.get(id);
    if (row) this.schedules.set(id, { ...row, status: 'executed' });
  }

  async listPendingSchedules(limit = 100): Promise<DeleteScheduleRow[]> {
    return [...this.schedules.values()]
      .filter((r) => r.status === 'pending')
      .slice(0, limit);
  }

  async createTombstone(input: {
    originalId: string;
    emailHash: string;
    roles: string[];
    tenantId?: string | null;
    workspaceId?: string | null;
    deletedBy: string;
    deleteReason?: string;
    snapshot: Record<string, unknown>;
    retentionDays: number;
  }): Promise<TombstoneRow> {
    const id = `tomb-${this.tombstoneCounter++}`;
    const row: TombstoneRow = {
      id,
      originalId: input.originalId,
      emailHash: input.emailHash,
      purgedAt: new Date(),
    };
    this.tombstones.set(input.originalId, row);
    return row;
  }

  async findTombstone(originalId: string): Promise<TombstoneRow | null> {
    return this.tombstones.get(originalId) ?? null;
  }
}
