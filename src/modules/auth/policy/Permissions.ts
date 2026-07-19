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
