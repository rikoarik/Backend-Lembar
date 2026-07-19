import type { UserRole } from '../../../infrastructure/database/schema.js';

export const PERMISSIONS = {
  assessmentCreate: 'assessment.create',
  assessmentRead: 'assessment.read',
  assessmentReview: 'assessment.review',
  assessmentFinalize: 'assessment.finalize',
  sourceManage: 'source.manage',
  libraryManage: 'library.manage',
  workspaceMemberManage: 'workspace.member.manage',
  workspaceUsageRead: 'workspace.usage.read',
  platformSupportAct: 'platform.support.act',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  superadmin: [
    PERMISSIONS.assessmentCreate,
    PERMISSIONS.assessmentRead,
    PERMISSIONS.assessmentReview,
    PERMISSIONS.assessmentFinalize,
    PERMISSIONS.sourceManage,
    PERMISSIONS.libraryManage,
    PERMISSIONS.workspaceMemberManage,
    PERMISSIONS.workspaceUsageRead,
    PERMISSIONS.platformSupportAct,
  ],
  school_admin: [
    PERMISSIONS.assessmentCreate,
    PERMISSIONS.assessmentRead,
    PERMISSIONS.assessmentReview,
    PERMISSIONS.assessmentFinalize,
    PERMISSIONS.sourceManage,
    PERMISSIONS.libraryManage,
    PERMISSIONS.workspaceMemberManage,
    PERMISSIONS.workspaceUsageRead,
  ],
  teacher: [
    PERMISSIONS.assessmentCreate,
    PERMISSIONS.assessmentRead,
    PERMISSIONS.assessmentReview,
    PERMISSIONS.sourceManage,
  ],
  subscriber: [PERMISSIONS.assessmentRead],
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
