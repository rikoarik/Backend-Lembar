/**
 * B7-01 — School workspace domain types.
 */
import type { UserRole } from '../../../infrastructure/database/schema.js';

export interface SchoolWorkspace {
  id: string;
  tenantId: string;
  name: string;
  level: string;
  createdAt: string;
}

export interface SchoolMember {
  id: string;
  email: string;
  role: UserRole;
  state: string;
  joinedAt: string;
}

export interface SchoolInvitationInput {
  workspaceId: string;
  email: string;
  role: UserRole;
  createdByUserId: string;
  tenantId: string;
}

export interface SchoolInvitationResult {
  /** One-time token (send to invitee — NOT stored, only hash stored) */
  token: string;
  tokenHash: string;
  email: string;
  expiresAt: string;
}

export interface AcceptInvitationInput {
  token: string;
  password: string;
}

export interface AcceptInvitationResult {
  userId: string;
  workspaceId: string;
}

export type OnboardingStatus = 'not_started' | 'in_progress' | 'completed';

export interface TeacherOnboardingRecord {
  userId: string;
  workspaceId: string;
  status: OnboardingStatus;
  completedAt: string | null;
  updatedAt: string;
}

export interface BillingSnapshot {
  workspaceId: string;
  plan: 'free' | 'pro';
  seatCount: number;
  generationsUsedThisMonth: number;
  monthlyLimit: number | null;
  billingCycleStartedAt: string;
}
