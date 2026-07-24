/**
 * School module exports (B7-01).
 */
export { SchoolService, InvalidInvitationError } from './application/SchoolService.js';
export type {
  SchoolWorkspaceStore,
  SchoolInvitationStore,
} from './application/SchoolService.js';
export type {
  SchoolWorkspace,
  SchoolMember,
  SchoolInvitationInput,
  SchoolInvitationResult,
  AcceptInvitationInput,
  AcceptInvitationResult,
  OnboardingStatus,
  TeacherOnboardingRecord,
  BillingSnapshot,
} from './domain/types.js';
export { registerSchoolRoutes } from './adapters/http/schoolRoutes.js';
export type { RegisterSchoolRoutesOptions } from './adapters/http/schoolRoutes.js';
