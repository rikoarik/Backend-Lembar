/**
 * Plans module exports (B6-01).
 */
export { PlanService } from './application/PlanService.js';
export { WorkspacePlanRepository } from './persistence/repository.js';
export { workspacePlans, PLAN_TYPES, FREE_MONTHLY_LIMIT } from './persistence/schema.js';
export type { WorkspacePlan, NewWorkspacePlan, PlanType } from './persistence/schema.js';
export type { WorkspacePlanSummary, PlanTransitionInput, QuotaCheckInput } from './domain/types.js';
export { QuotaExceededError, PlanNotFoundError } from './domain/errors.js';
export { registerPlanRoutes } from './adapters/http/planRoutes.js';
export { createQuotaMiddleware } from './adapters/http/quotaMiddleware.js';
