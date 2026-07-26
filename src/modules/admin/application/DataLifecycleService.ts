/**
 * B8-02 — Data lifecycle application service.
 *
 * Tanggung jawab:
 * - scheduleDelete: soft-mark + antrian purge setelah retention window
 * - purgeAccount: hard-delete + tulis tombstone (audit trail)
 * - cancelDelete: batalkan jadwal purge
 * - listPendingDeletes: tampilkan antrian aktif
 *
 * Service ini murni domain-logic — semua I/O lewat store interfaces.
 */
import { createHash } from 'node:crypto';
import type { AdminAuditStore } from '../domain/AdminAuditStore.js';
import { DEFAULT_RETENTION_DAYS } from '../persistence/lifecycleSchema.js';

// ── Store interfaces ──────────────────────────────────────────────────────────

export interface AccountRow {
  id: string;
  email: string;
  roles: string[];
  tenantId?: string | null;
  workspaceId?: string | null;
  deletedAt?: Date | null;
  createdAt?: Date | null;
}

export interface DeleteScheduleRow {
  id: string;
  accountId: string;
  scheduledBy: string;
  purgeAfter: Date;
  retentionDays: number;
  reason?: string | null;
  status: string;
}

export interface TombstoneRow {
  id: string;
  originalId: string;
  emailHash: string;
  purgedAt: Date;
}

export interface LifecycleStore {
  findAccount(id: string): Promise<AccountRow | null>;
  softDeleteAccount(id: string): Promise<void>;
  hardDeleteAccount(id: string): Promise<void>;
  createDeleteSchedule(input: {
    accountId: string;
    scheduledBy: string;
    purgeAfter: Date;
    retentionDays: number;
    reason?: string;
  }): Promise<DeleteScheduleRow>;
  findPendingSchedule(accountId: string): Promise<DeleteScheduleRow | null>;
  cancelDeleteSchedule(id: string): Promise<void>;
  markScheduleExecuted(id: string): Promise<void>;
  listPendingSchedules(limit?: number): Promise<DeleteScheduleRow[]>;
  createTombstone(input: {
    originalId: string;
    emailHash: string;
    roles: string[];
    tenantId?: string | null;
    workspaceId?: string | null;
    deletedBy: string;
    deleteReason?: string;
    snapshot: Record<string, unknown>;
    retentionDays: number;
  }): Promise<TombstoneRow>;
  findTombstone(originalId: string): Promise<TombstoneRow | null>;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class DataLifecycleService {
  constructor(
    private readonly store: LifecycleStore,
    private readonly audit: AdminAuditStore,
  ) {}

  /**
   * Jadwalkan hard-delete setelah retention window (default 30 hari).
   * Juga soft-delete akun agar tidak aktif selama masa tunggu.
   */
  async scheduleDelete(
    actorId: string,
    accountId: string,
    options?: { retentionDays?: number; reason?: string },
  ): Promise<DeleteScheduleRow> {
    const retentionDays = options?.retentionDays ?? DEFAULT_RETENTION_DAYS;

    const account = await this.store.findAccount(accountId);
    if (!account) {
      throw Object.assign(new Error('Account not found'), { code: 'NOT_FOUND' });
    }

    // Cegah double-schedule
    const existing = await this.store.findPendingSchedule(accountId);
    if (existing) {
      throw Object.assign(new Error('Delete already scheduled for this account'), {
        code: 'CONFLICT',
      });
    }

    const purgeAfter = new Date();
    purgeAfter.setDate(purgeAfter.getDate() + retentionDays);

    // Soft-delete dulu
    await this.store.softDeleteAccount(accountId);

    const schedule = await this.store.createDeleteSchedule({
      accountId,
      scheduledBy: actorId,
      purgeAfter,
      retentionDays,
      ...(options?.reason !== undefined && { reason: options.reason }),
    });

    await this.audit.append({
      action: 'admin.account.delete_scheduled',
      actorId,
      targetId: accountId,
      metadata: { retentionDays, purgeAfter: purgeAfter.toISOString(), reason: options?.reason },
    });

    return schedule;
  }

  /**
   * Hard-delete akun + tulis tombstone sebagai audit trail permanen.
   * Hanya boleh dipanggil oleh superadmin.
   */
  async purgeAccount(
    actorId: string,
    accountId: string,
    options?: { reason?: string; retentionDays?: number },
  ): Promise<TombstoneRow> {
    // Cek tombstone DULU — jika sudah ada, tolak tanpa lihat akun
    const existingTombstone = await this.store.findTombstone(accountId);
    if (existingTombstone) {
      throw Object.assign(new Error('Account already purged (tombstone exists)'), {
        code: 'GONE',
      });
    }

    const account = await this.store.findAccount(accountId);
    if (!account) {
      throw Object.assign(new Error('Account not found'), { code: 'NOT_FOUND' });
    }

    const retentionDays = options?.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const emailHash = createHash('sha256').update(account.email.toLowerCase()).digest('hex');

    // Snapshot data sebelum dihapus (tanpa PII langsung)
    const snapshot: Record<string, unknown> = {
      roles: account.roles,
      tenantId: account.tenantId ?? null,
      workspaceId: account.workspaceId ?? null,
      createdAt: account.createdAt?.toISOString() ?? null,
    };

    // Mark schedule sebagai executed jika ada
    const pending = await this.store.findPendingSchedule(accountId);
    if (pending) {
      await this.store.markScheduleExecuted(pending.id);
    }

    // Hard-delete
    await this.store.hardDeleteAccount(accountId);

    // Tulis tombstone (immutable, tidak bisa dihapus)
    const tombstone = await this.store.createTombstone({
      originalId: accountId,
      emailHash,
      roles: account.roles,
      ...(account.tenantId !== undefined && { tenantId: account.tenantId }),
      ...(account.workspaceId !== undefined && { workspaceId: account.workspaceId }),
      deletedBy: actorId,
      ...(options?.reason !== undefined && { deleteReason: options.reason }),
      snapshot,
      retentionDays,
    });

    await this.audit.append({
      action: 'admin.account.purged',
      actorId,
      targetId: accountId,
      metadata: {
        tombstoneId: tombstone.id,
        emailHash,
        reason: options?.reason,
        retentionDays,
      },
    });

    return tombstone;
  }

  /**
   * Batalkan jadwal purge yang masih pending.
   */
  async cancelScheduledDelete(actorId: string, accountId: string): Promise<void> {
    const schedule = await this.store.findPendingSchedule(accountId);
    if (!schedule) {
      throw Object.assign(new Error('No pending delete schedule for this account'), {
        code: 'NOT_FOUND',
      });
    }

    await this.store.cancelDeleteSchedule(schedule.id);

    // Undo soft-delete agar akun aktif lagi
    // (set deleted_at = NULL — dilakukan store)

    await this.audit.append({
      action: 'admin.account.delete_cancelled',
      actorId,
      targetId: accountId,
      metadata: { scheduleId: schedule.id },
    });
  }

  /**
   * Daftar akun yang terjadwal untuk purge.
   */
  async listPendingDeletes(
    actorId: string,
    limit?: number,
  ): Promise<DeleteScheduleRow[]> {
    const rows = await this.store.listPendingSchedules(limit);
    await this.audit.append({
      action: 'admin.lifecycle.list_pending_deletes',
      actorId,
      targetId: '',
      metadata: { count: rows.length },
    });
    return rows;
  }
}
