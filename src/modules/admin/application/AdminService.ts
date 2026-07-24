/**
 * B6-03 — Superadmin application service.
 *
 * Handles admin ops: list accounts, list jobs, list quality reports,
 * set entitlements. All actions are audit-logged.
 */
import type { AdminAuditStore } from '../domain/AdminAuditStore.js';
import type {
  AdminAccountSummary,
  AdminJobSummary,
  AdminQualityReport,
  AdminEntitlementInput,
  AdminAuditEntry,
} from '../domain/types.js';

export interface AdminDataStore {
  listAccounts(): Promise<AdminAccountSummary[]>;
  listJobs(limit?: number): Promise<AdminJobSummary[]>;
  listQualityReports(limit?: number): Promise<AdminQualityReport[]>;
  setEntitlement(input: AdminEntitlementInput): Promise<{ workspaceId: string; plan: string }>;
}

export class AdminService {
  constructor(
    private readonly dataStore: AdminDataStore,
    private readonly auditStore: AdminAuditStore,
  ) {}

  async listAccounts(actorId: string): Promise<AdminAccountSummary[]> {
    await this.auditStore.append({
      action: 'admin.accounts.list',
      actorId,
      targetId: '',
      metadata: {},
    });
    return this.dataStore.listAccounts();
  }

  async listJobs(actorId: string, limit?: number): Promise<AdminJobSummary[]> {
    await this.auditStore.append({
      action: 'admin.jobs.list',
      actorId,
      targetId: '',
      metadata: { limit: limit ?? 100 },
    });
    return this.dataStore.listJobs(limit);
  }

  async listQualityReports(actorId: string, limit?: number): Promise<AdminQualityReport[]> {
    await this.auditStore.append({
      action: 'admin.quality_reports.list',
      actorId,
      targetId: '',
      metadata: { limit: limit ?? 100 },
    });
    return this.dataStore.listQualityReports(limit);
  }

  async setEntitlement(
    actorId: string,
    input: AdminEntitlementInput,
  ): Promise<{ workspaceId: string; plan: string }> {
    const result = await this.dataStore.setEntitlement({ ...input, actorId });
    await this.auditStore.append({
      action: 'admin.entitlement.set',
      actorId,
      targetId: input.workspaceId,
      metadata: { plan: input.plan, workspaceId: input.workspaceId },
    });
    return result;
  }

  async getAuditTrail(actorId: string, limit?: number): Promise<AdminAuditEntry[]> {
    const entries = await this.auditStore.list(limit);
    // Log the audit read itself (after to avoid infinite recursion)
    await this.auditStore.append({
      action: 'admin.audit.read',
      actorId,
      targetId: '',
      metadata: { limit: limit ?? 100 },
    });
    return entries;
  }
}
