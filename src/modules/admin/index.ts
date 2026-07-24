/**
 * Admin module exports (B6-03).
 */
export { AdminService } from './application/AdminService.js';
export { InMemoryAdminAuditStore } from './domain/AdminAuditStore.js';
export type { AdminAuditStore } from './domain/AdminAuditStore.js';
export type {
  AdminAccountSummary,
  AdminJobSummary,
  AdminQualityReport,
  AdminEntitlementInput,
  AdminAuditEntry,
} from './domain/types.js';
export { registerAdminRoutes } from './adapters/http/adminRoutes.js';
export type { RegisterAdminRoutesOptions } from './adapters/http/adminRoutes.js';
