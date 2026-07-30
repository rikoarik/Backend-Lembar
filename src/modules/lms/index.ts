/**
 * LMS module exports (LMS-A: guest attempt + LMS-B: member attempt).
 */
export type { GuestAttempt, AttemptStore } from './domain/Attempt.js';
export type { MemberAttempt, MemberAttemptStore } from './domain/MemberAttempt.js';
export { AttemptService } from './application/AttemptService.js';
export type { AttemptServiceDeps } from './application/AttemptService.js';
export { InMemoryAttemptStore } from './persistence/InMemoryAttemptStore.js';
export { InMemoryMemberAttemptStore } from './persistence/InMemoryMemberAttemptStore.js';
export { registerAttemptRoutes } from './adapters/http/attemptRoutes.js';
export { registerMemberAttemptRoutes } from './adapters/http/memberAttemptRoutes.js';
