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
export { registerMemberRoutes } from './adapters/http/memberRoutes.js';
export type { RegisterMemberRoutesOptions } from './adapters/http/memberRoutes.js';
export { registerStatsRoutes } from './adapters/http/statsRoutes.js';
export type { RegisterStatsRoutesOptions, StatsData } from './adapters/http/statsRoutes.js';
export { registerSuspendRoutes } from './adapters/http/suspendRoutes.js';
export { registerLibraryRoutes } from './adapters/http/libraryRoutes.js';
export { registerSchoolAuditRoutes } from './adapters/http/schoolAuditRoutes.js';
export { registerSettingsRoutes } from './adapters/http/settingsRoutes.js';
export { registerUsageRoutes } from './adapters/http/usageRoutes.js';
export { registerSchoolNotificationsRoutes } from './adapters/http/schoolNotificationsRoutes.js';
export { PostgresSchoolInvitationStore } from './persistence/PostgresSchoolStores.js';
