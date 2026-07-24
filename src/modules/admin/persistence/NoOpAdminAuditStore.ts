/**
 * No-op admin audit store — writes nothing, used when audit is not required.
 */
import type { AdminAuditStore } from '../domain/AdminAuditStore.js';
import type { AdminAuditEntry } from '../domain/types.js';

export class NoOpAdminAuditStore implements AdminAuditStore {
  async append(_entry: Omit<AdminAuditEntry, 'id' | 'createdAt'>): Promise<AdminAuditEntry> {
    // No-op: audit disabled, return stub entry
    return {
      id: 'noop',
      action: _entry.action,
      actorId: _entry.actorId,
      targetId: _entry.targetId ?? null,
      metadata: _entry.metadata,
      createdAt: new Date().toISOString(),
    };
  }

  async list(_limit?: number): Promise<AdminAuditEntry[]> {
    return [];
  }
}
