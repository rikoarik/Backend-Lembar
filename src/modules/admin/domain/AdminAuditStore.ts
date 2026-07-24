/**
 * B6-03 — Superadmin audit log (in-memory store with interface).
 *
 * Persists all superadmin actions for auditability.
 * In production this would write to a dedicated audit table.
 */
import type { AdminAuditEntry } from './types.js';

export interface AdminAuditStore {
  append(entry: Omit<AdminAuditEntry, 'id' | 'createdAt'>): Promise<AdminAuditEntry>;
  list(limit?: number): Promise<AdminAuditEntry[]>;
}

export class InMemoryAdminAuditStore implements AdminAuditStore {
  private entries: AdminAuditEntry[] = [];
  private counter = 0;

  async append(entry: Omit<AdminAuditEntry, 'id' | 'createdAt'>): Promise<AdminAuditEntry> {
    const record: AdminAuditEntry = {
      id: `audit-${++this.counter}`,
      ...entry,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(record);
    return record;
  }

  async list(limit = 100): Promise<AdminAuditEntry[]> {
    return [...this.entries].reverse().slice(0, limit);
  }

  // Helper for tests
  getAll(): AdminAuditEntry[] {
    return [...this.entries];
  }
}
