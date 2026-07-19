import type { Database } from '../../../infrastructure/database/db.js';
import { InMemoryAuthStore } from '../adapters/persistence/InMemoryAuthStore.js';
import { PostgresAuthStore } from '../adapters/persistence/PostgresAuthStore.js';
import { AuthService, type AuthStore } from './AuthService.js';
import { MemoryNotificationAdapter } from '../../notifications/domain/NotificationAdapter.js';

export interface CreateAuthServiceOptions {
  store?: AuthStore;
  db?: Database;
  sessionIdleMs?: number;
  sessionAbsoluteMs?: number;
  recoveryTokenTtlMs?: number;
  inviteTokenTtlMs?: number;
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
  appUrl?: string;
}

export function createAuthService(options: CreateAuthServiceOptions = {}): AuthService {
  const store =
    options.store ??
    (options.db
      ? new PostgresAuthStore({
          db: options.db,
          notificationAdapter: new MemoryNotificationAdapter(),
        })
      : new InMemoryAuthStore());

  const serviceOptions: ConstructorParameters<typeof AuthService>[0] = {
    store,
    sessionIdleMs: options.sessionIdleMs ?? 30 * 60 * 1000,
    sessionAbsoluteMs: options.sessionAbsoluteMs ?? 8 * 60 * 60 * 1000,
    recoveryTokenTtlMs: options.recoveryTokenTtlMs ?? 15 * 60 * 1000,
    inviteTokenTtlMs: options.inviteTokenTtlMs ?? 60 * 60 * 1000,
    rateLimitWindowMs: options.rateLimitWindowMs ?? 60_000,
    rateLimitMax: options.rateLimitMax ?? 5,
  };
  if (options.appUrl) serviceOptions.appUrl = options.appUrl;
  return new AuthService(serviceOptions);
}
