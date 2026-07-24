/**
 * B6-03 — Superadmin ops & audit.
 *
 * Domain types for admin operations.
 */
import type { UserRole } from '../../../infrastructure/database/schema.js';

export interface AdminAccountSummary {
  id: string;
  email: string;
  role: UserRole;
  workspaceId: string;
  membershipState: string;
  createdAt: string;
}

export interface AdminJobSummary {
  id: string;
  workspaceId: string;
  actorId: string;
  kind: string;
  status: string;
  attempt: number;
  createdAt: string;
}

export interface AdminQualityReport {
  id: string;
  workspaceId: string;
  assessmentVersionId: string;
  valid: boolean;
  issueCount: number;
  createdAt: string;
}

export interface AdminEntitlementInput {
  workspaceId: string;
  plan: 'free' | 'pro';
  actorId: string;
}

export interface AdminAuditEntry {
  id: string;
  action: string;
  actorId: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}
