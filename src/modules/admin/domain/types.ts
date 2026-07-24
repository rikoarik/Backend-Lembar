/**
 * Superadmin ops & audit domain types.
 */
export interface AdminAccountSummary {
  id: string;
  email: string;
  name: string;
  displayName: string;
  role: 'teacher' | 'school_admin' | 'superadmin' | 'subscriber';
  status: 'aktif' | 'baru' | 'ditangguhkan';
  school: string;
  workspaceId: string;
  createdAt: string;
}

export interface AdminJobSummary {
  id: string;
  type: string;
  tenant: string;
  status: 'queued' | 'running' | 'failed' | 'succeeded';
  progress: string;
  updatedAt: string;
}

export interface AdminQualityReport {
  id: string;
  reason: string;
  status: 'open' | 'triaged' | 'closed';
  reporter: string;
  notes: string;
  createdAt: string;
}

export interface AdminEntitlementInput {
  workspaceId: string;
  plan: 'free' | 'pro';
  actorId: string;
}

/** Audit entry — stored in admin_audit table. */
export interface AdminAuditEntry {
  id: string;
  actorId: string;
  action: string;
  targetType?: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
