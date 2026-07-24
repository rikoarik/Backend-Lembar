/**
 * Ops module exports (B6-04).
 */
export { MetricsCollector } from './application/MetricsCollector.js';
export {
  LeadCaptureService,
  InMemoryLeadStore,
  LeadValidationError,
  LeadTooFrequentError,
} from './application/LeadCaptureService.js';
export type { LeadStore } from './application/LeadCaptureService.js';
export type { MetricsSnapshot, LeadCaptureInput, LeadRecord } from './domain/types.js';
export { registerOpsRoutes } from './adapters/http/opsRoutes.js';
export type { RegisterOpsRoutesOptions } from './adapters/http/opsRoutes.js';
