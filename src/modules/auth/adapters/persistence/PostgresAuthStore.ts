import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { Database } from '../../../../infrastructure/database/db.js';
import { tenants } from '../../../../infrastructure/database/schema.js';
import type {
  AuditAction,
  AuditEventRecord,
  AuthStore,
  AuthUser,
  InvitationRecord,
  RateLimitRecord,
  RecoveryTokenRecord,
  SessionRecord,
  WorkspaceMembership,
  WorkspaceRecord,
} from '../../application/AuthService.js';
import type {
  NotificationAdapter,
  NotificationSendInput,
} from '../../../notifications/domain/NotificationAdapter.js';
import { NotificationService } from '../../../notifications/domain/NotificationService.js';
import { NotificationRepository } from '../../../notifications/persistence/NotificationRepository.js';
import {
  auditEvents,
  authAccounts,
  authWorkspaceMemberships,
  rateLimits,
  recoveryTokens,
  schoolInvitations,
  sessions,
} from '../../persistence/schema.js';

export type AuthDb = Database | NodePgDatabase<Record<string, never>>;

interface PostgresAuthStoreOptions {
  db: AuthDb;
  notificationAdapter?: NotificationAdapter | undefined;
  notificationClock?: (() => Date) | undefined;
}

export class PostgresAuthStore implements AuthStore {
  private readonly db: AuthDb;
  private readonly notificationAdapter: NotificationAdapter | undefined;
  private readonly notificationClock: (() => Date) | undefined;

  constructor(options: PostgresAuthStoreOptions) {
    this.db = options.db;
    this.notificationAdapter = options.notificationAdapter;
    this.notificationClock = options.notificationClock;
  }

  async getUserByEmail(email: string): Promise<AuthUser | null> {
    const [row] = await this.db
      .select()
      .from(authAccounts)
      .where(eq(authAccounts.email, email))
      .limit(1);
    return row ? mapUser(row) : null;
  }

  async getUserById(id: string): Promise<AuthUser | null> {
    const [row] = await this.db.select().from(authAccounts).where(eq(authAccounts.id, id)).limit(1);
    return row ? mapUser(row) : null;
  }

  async saveUser(user: AuthUser): Promise<void> {
    await this.db
      .insert(authAccounts)
      .values({
        id: user.id,
        email: user.email,
        passwordHash: user.passwordHash,
        sessionVersion: user.sessionVersion,
        createdAt: user.createdAt,
      })
      .onConflictDoUpdate({
        target: authAccounts.id,
        set: {
          email: user.email,
          passwordHash: user.passwordHash,
          sessionVersion: user.sessionVersion,
        },
      });
  }

  async saveWorkspace(workspace: WorkspaceRecord): Promise<void> {
    await this.db
      .insert(tenants)
      .values({ id: workspace.id, slug: workspace.slug, name: workspace.name })
      .onConflictDoUpdate({
        target: tenants.id,
        set: { slug: workspace.slug, name: workspace.name },
      });
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null> {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.id, workspaceId)).limit(1);
    if (!row) return null;
    return { id: row.id, slug: row.slug, name: row.name };
  }

  async saveMembership(membership: WorkspaceMembership): Promise<void> {
    await this.db
      .insert(authWorkspaceMemberships)
      .values({
        accountId: membership.userId,
        tenantId: membership.workspaceId,
        role: membership.role,
        state: membership.state,
      })
      .onConflictDoUpdate({
        target: [authWorkspaceMemberships.accountId, authWorkspaceMemberships.tenantId],
        set: {
          role: membership.role,
          state: membership.state,
        },
      });
  }

  async getMembership(userId: string, workspaceId: string): Promise<WorkspaceMembership | null> {
    const [row] = await this.db
      .select()
      .from(authWorkspaceMemberships)
      .where(
        and(
          eq(authWorkspaceMemberships.accountId, userId),
          eq(authWorkspaceMemberships.tenantId, workspaceId),
        ),
      )
      .limit(1);
    return row ? mapMembership(row) : null;
  }

  async listMemberships(userId: string): Promise<WorkspaceMembership[]> {
    const rows = await this.db
      .select()
      .from(authWorkspaceMemberships)
      .where(eq(authWorkspaceMemberships.accountId, userId));
    return rows.map(mapMembership);
  }

  async saveSession(session: SessionRecord): Promise<void> {
    await this.db
      .insert(sessions)
      .values({
        id: session.id,
        userId: session.userId,
        tenantId: session.workspaceId,
        csrfToken: session.csrfToken,
        sessionVersion: session.version,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
        state: session.revokedAt ? 'revoked' : 'active',
        revokedAt: session.revokedAt,
      })
      .onConflictDoUpdate({
        target: sessions.id,
        set: {
          tenantId: session.workspaceId,
          csrfToken: session.csrfToken,
          sessionVersion: session.version,
          idleExpiresAt: session.idleExpiresAt,
          absoluteExpiresAt: session.absoluteExpiresAt,
          state: session.revokedAt ? 'revoked' : 'active',
          revokedAt: session.revokedAt,
        },
      });
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return row ? mapSession(row) : null;
  }

  async revokeSession(id: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ state: 'revoked', revokedAt: sql`coalesce(${sessions.revokedAt}, now())` })
      .where(eq(sessions.id, id));
  }

  async revokeSessionsForUser(userId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ state: 'revoked', revokedAt: sql`coalesce(${sessions.revokedAt}, now())` })
      .where(and(eq(sessions.userId, userId), eq(sessions.state, 'active')));
  }

  async saveRecoveryToken(token: RecoveryTokenRecord): Promise<void> {
    await this.db
      .insert(recoveryTokens)
      .values({
        userId: token.userId,
        tokenHash: token.tokenHash,
        state: token.consumedAt ? 'consumed' : 'pending',
        expiresAt: token.expiresAt,
        consumedAt: token.consumedAt,
      })
      .onConflictDoUpdate({
        target: recoveryTokens.tokenHash,
        set: {
          userId: token.userId,
          state: token.consumedAt ? 'consumed' : 'pending',
          expiresAt: token.expiresAt,
          consumedAt: token.consumedAt,
        },
      });
  }

  async getRecoveryToken(tokenHash: string): Promise<RecoveryTokenRecord | null> {
    const [row] = await this.db
      .select()
      .from(recoveryTokens)
      .where(eq(recoveryTokens.tokenHash, tokenHash))
      .limit(1);
    if (!row) return null;
    return {
      tokenHash: row.tokenHash,
      userId: row.userId,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
    };
  }

  async consumeRecoveryToken(tokenHash: string, consumedAt: Date): Promise<void> {
    await this.db
      .update(recoveryTokens)
      .set({ state: 'consumed', consumedAt })
      .where(eq(recoveryTokens.tokenHash, tokenHash));
  }

  async saveInvitation(invitation: InvitationRecord): Promise<void> {
    await this.db
      .insert(schoolInvitations)
      .values({
        tenantId: invitation.workspaceId,
        email: invitation.email,
        role: invitation.role,
        state: invitation.state,
        tokenHash: invitation.tokenHash,
        expiresAt: invitation.expiresAt,
        acceptedBy: invitation.acceptedBy ?? null,
      })
      .onConflictDoUpdate({
        target: schoolInvitations.tokenHash,
        set: {
          email: invitation.email,
          role: invitation.role,
          state: invitation.state,
          expiresAt: invitation.expiresAt,
          acceptedBy: invitation.acceptedBy ?? null,
        },
      });
  }

  async getInvitation(tokenHash: string): Promise<InvitationRecord | null> {
    const [row] = await this.db
      .select()
      .from(schoolInvitations)
      .where(eq(schoolInvitations.tokenHash, tokenHash))
      .limit(1);
    if (!row) return null;
    return {
      tokenHash: row.tokenHash,
      email: row.email,
      workspaceId: row.tenantId,
      role: row.role,
      state: row.state,
      expiresAt: row.expiresAt,
      acceptedBy: row.acceptedBy,
    };
  }

  async saveAudit(event: AuditEventRecord): Promise<void> {
    await this.db.insert(auditEvents).values({
      action: event.action,
      userId: event.userId,
      tenantId: event.workspaceId,
      occurredAt: event.occurredAt,
      metadata: null,
    });
  }

  async countAudit(action: AuditAction): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(eq(auditEvents.action, action));
    return row?.count ?? 0;
  }

  async getRateLimit(key: string): Promise<RateLimitRecord | null> {
    const [row] = await this.db.select().from(rateLimits).where(eq(rateLimits.key, key)).limit(1);
    if (!row) return null;
    return {
      key: row.key,
      count: row.count,
      windowStartedAt: row.windowStartedAt,
    };
  }

  async saveRateLimit(record: RateLimitRecord): Promise<void> {
    await this.db
      .insert(rateLimits)
      .values(record)
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: {
          count: record.count,
          windowStartedAt: record.windowStartedAt,
        },
      });
  }

  async transaction<T>(fn: (store: AuthStore) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const options: PostgresAuthStoreOptions = { db: tx as AuthDb };
      if (this.notificationAdapter) options.notificationAdapter = this.notificationAdapter;
      if (this.notificationClock) options.notificationClock = this.notificationClock;
      return fn(new PostgresAuthStore(options));
    });
  }

  async sendNotification(input: NotificationSendInput): Promise<void> {
    if (!this.notificationAdapter) return;
    const service = new NotificationService({
      adapter: this.notificationAdapter,
      repository: new NotificationRepository(this.db),
      ...(this.notificationClock ? { clock: this.notificationClock } : {}),
    });
    const result = await service.dispatch(input);
    if (result.status === 'rejected') throw new Error('notification dispatch rejected');
  }
}

function mapUser(row: typeof authAccounts.$inferSelect): AuthUser {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    sessionVersion: row.sessionVersion,
    createdAt: row.createdAt,
  };
}

function mapMembership(row: typeof authWorkspaceMemberships.$inferSelect): WorkspaceMembership {
  return {
    workspaceId: row.tenantId,
    userId: row.accountId,
    role: row.role,
    state: row.state,
  };
}

function mapSession(row: typeof sessions.$inferSelect): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.tenantId,
    csrfToken: row.csrfToken,
    version: row.sessionVersion,
    idleExpiresAt: row.idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    revokedAt: row.state === 'revoked' ? (row.revokedAt ?? row.createdAt) : row.revokedAt,
  };
}
