import type { NotificationSendInput } from '../../../notifications/domain/NotificationAdapter.js';
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

export class InMemoryAuthStore implements AuthStore {
  private readonly users = new Map<string, AuthUser>();
  private readonly usersByEmail = new Map<string, string>();
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly memberships = new Map<string, WorkspaceMembership>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly recoveryTokens = new Map<string, RecoveryTokenRecord>();
  private readonly invitations = new Map<string, InvitationRecord>();
  private readonly audits: AuditEventRecord[] = [];
  private readonly rateLimits = new Map<string, RateLimitRecord>();
  readonly notifications: NotificationSendInput[] = [];

  async sendNotification(input: NotificationSendInput): Promise<void> {
    this.notifications.push(structuredClone(input));
  }

  latestNotification(): NotificationSendInput | null {
    return this.notifications.at(-1) ?? null;
  }

  notificationCount(templateKey?: string): number {
    return templateKey
      ? this.notifications.filter((entry) => entry.templateKey === templateKey).length
      : this.notifications.length;
  }

  tokenFromNotification(templateKey: string): string | null {
    const entry = [...this.notifications]
      .reverse()
      .find((item) => item.templateKey === templateKey);
    if (!entry) return null;
    const payload = entry.payload as { code?: unknown; accept_url?: unknown };
    if (typeof payload.code === 'string') return payload.code;
    if (typeof payload.accept_url === 'string') {
      const url = new URL(payload.accept_url);
      return url.searchParams.get('token');
    }
    return null;
  }

  clearNotifications(): void {
    this.notifications.length = 0;
  }

  async getUserByEmail(email: string): Promise<AuthUser | null> {
    const id = this.usersByEmail.get(email);
    return id ? (this.users.get(id) ?? null) : null;
  }

  async getUserById(id: string): Promise<AuthUser | null> {
    return this.users.get(id) ?? null;
  }

  async saveUser(user: AuthUser): Promise<void> {
    this.users.set(user.id, { ...user });
    this.usersByEmail.set(user.email, user.id);
  }

  async saveWorkspace(workspace: WorkspaceRecord): Promise<void> {
    this.workspaces.set(workspace.id, { ...workspace });
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null> {
    return this.workspaces.get(workspaceId) ?? null;
  }

  async saveMembership(membership: WorkspaceMembership): Promise<void> {
    this.memberships.set(this.membershipKey(membership.userId, membership.workspaceId), {
      ...membership,
    });
  }

  async getMembership(userId: string, workspaceId: string): Promise<WorkspaceMembership | null> {
    return this.memberships.get(this.membershipKey(userId, workspaceId)) ?? null;
  }

  async listMemberships(userId: string): Promise<WorkspaceMembership[]> {
    return [...this.memberships.values()].filter((membership) => membership.userId === userId);
  }

  async saveSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async revokeSession(id: string): Promise<void> {
    const current = this.sessions.get(id);
    if (!current) return;
    this.sessions.set(id, { ...current, revokedAt: current.revokedAt ?? new Date() });
  }

  async revokeSessionsForUser(userId: string): Promise<void> {
    for (const [id, session] of this.sessions.entries()) {
      if (session.userId === userId) {
        this.sessions.set(id, { ...session, revokedAt: session.revokedAt ?? new Date() });
      }
    }
  }

  async saveRecoveryToken(token: RecoveryTokenRecord): Promise<void> {
    this.recoveryTokens.set(token.tokenHash, { ...token });
  }

  async getRecoveryToken(tokenHash: string): Promise<RecoveryTokenRecord | null> {
    return this.recoveryTokens.get(tokenHash) ?? null;
  }

  async consumeRecoveryToken(tokenHash: string, consumedAt: Date): Promise<void> {
    const token = this.recoveryTokens.get(tokenHash);
    if (!token) return;
    this.recoveryTokens.set(tokenHash, { ...token, consumedAt });
  }

  async saveInvitation(invitation: InvitationRecord): Promise<void> {
    this.invitations.set(invitation.tokenHash, { ...invitation });
  }

  async getInvitation(tokenHash: string): Promise<InvitationRecord | null> {
    return this.invitations.get(tokenHash) ?? null;
  }

  async saveAudit(event: AuditEventRecord): Promise<void> {
    this.audits.push({ ...event });
  }

  async countAudit(action: AuditAction): Promise<number> {
    return this.audits.filter((event) => event.action === action).length;
  }

  async getRateLimit(key: string): Promise<RateLimitRecord | null> {
    return this.rateLimits.get(key) ?? null;
  }

  async saveRateLimit(record: RateLimitRecord): Promise<void> {
    this.rateLimits.set(record.key, { ...record });
  }

  async transaction<T>(fn: (store: AuthStore) => Promise<T>): Promise<T> {
    const snapshot = {
      users: new Map(this.users),
      usersByEmail: new Map(this.usersByEmail),
      workspaces: new Map(this.workspaces),
      memberships: new Map(this.memberships),
      sessions: new Map(this.sessions),
      recoveryTokens: new Map(this.recoveryTokens),
      invitations: new Map(this.invitations),
      audits: [...this.audits],
      rateLimits: new Map(this.rateLimits),
      notifications: [...this.notifications],
    };
    try {
      return await fn(this);
    } catch (err) {
      this.users.clear();
      for (const entry of snapshot.users) this.users.set(...entry);
      this.usersByEmail.clear();
      for (const entry of snapshot.usersByEmail) this.usersByEmail.set(...entry);
      this.workspaces.clear();
      for (const entry of snapshot.workspaces) this.workspaces.set(...entry);
      this.memberships.clear();
      for (const entry of snapshot.memberships) this.memberships.set(...entry);
      this.sessions.clear();
      for (const entry of snapshot.sessions) this.sessions.set(...entry);
      this.recoveryTokens.clear();
      for (const entry of snapshot.recoveryTokens) this.recoveryTokens.set(...entry);
      this.invitations.clear();
      for (const entry of snapshot.invitations) this.invitations.set(...entry);
      this.audits.length = 0;
      this.audits.push(...snapshot.audits);
      this.rateLimits.clear();
      for (const entry of snapshot.rateLimits) this.rateLimits.set(...entry);
      this.notifications.length = 0;
      this.notifications.push(...snapshot.notifications);
      throw err;
    }
  }

  private membershipKey(userId: string, workspaceId: string): string {
    return `${userId}:${workspaceId}`;
  }
}
