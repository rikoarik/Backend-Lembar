/**
 * School module exports (B7-01, B7-02, B7-03, B7-04).
 */
export { SchoolService, InvalidInvitationError } from './application/SchoolService.js';
export type {
  SchoolWorkspaceStore,
  SchoolInvitationStore,
} from './application/SchoolService.js';
export { SchoolDashboardService } from './application/SchoolDashboardService.js';
export type { DashboardData } from './application/SchoolDashboardService.js';
export { TeacherOnboardingService } from './application/TeacherOnboardingService.js';
export type { TeacherOnboardingStore } from './application/TeacherOnboardingService.js';
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
export { registerDashboardRoutes } from './adapters/http/dashboardRoutes.js';
export type { RegisterDashboardRoutesOptions } from './adapters/http/dashboardRoutes.js';
export { registerOnboardingRoutes } from './adapters/http/onboardingRoutes.js';
export type { RegisterOnboardingRoutesOptions } from './adapters/http/onboardingRoutes.js';
export { SchoolBillingService } from './application/SchoolBillingService.js';
export { registerBillingRoutes } from './adapters/http/billingRoutes.js';
export type { RegisterBillingRoutesOptions } from './adapters/http/billingRoutes.js';
