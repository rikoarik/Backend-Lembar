import { AuthService, type AuthStore } from './AuthService.js';
import { InMemoryAuthStore } from '../adapters/persistence/InMemoryAuthStore.js';

export interface CreateAuthServiceOptions {
  store?: AuthStore;
  sessionIdleMs?: number;
  sessionAbsoluteMs?: number;
  recoveryTokenTtlMs?: number;
  inviteTokenTtlMs?: number;
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
}

export function createAuthService(options: CreateAuthServiceOptions = {}): AuthService {
  return new AuthService({
    store: options.store ?? new InMemoryAuthStore(),
    sessionIdleMs: options.sessionIdleMs ?? 30 * 60 * 1000,
    sessionAbsoluteMs: options.sessionAbsoluteMs ?? 8 * 60 * 60 * 1000,
    recoveryTokenTtlMs: options.recoveryTokenTtlMs ?? 15 * 60 * 1000,
    inviteTokenTtlMs: options.inviteTokenTtlMs ?? 60 * 60 * 1000,
    rateLimitWindowMs: options.rateLimitWindowMs ?? 60_000,
    rateLimitMax: options.rateLimitMax ?? 5,
  });
}
