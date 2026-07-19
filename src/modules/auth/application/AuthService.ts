import { createHash, randomUUID } from 'node:crypto';

import { ApiError } from '../../../common/errors/envelope.js';
import type { NotificationSendInput } from '../../notifications/domain/NotificationAdapter.js';
import { USER_ROLES, type UserRole } from '../../../infrastructure/database/schema.js';
import { hasPermission, PERMISSIONS } from '../policy/Permissions.js';

export type MembershipState = 'active' | 'suspended' | 'revoked';
export type InvitationState = 'pending' | 'accepted' | 'expired' | 'revoked';
export type AuditAction =
  | 'register'
  | 'login'
  | 'logout'
  | 'logout_all'
  | 'recovery_request'
  | 'recovery_complete'
  | 'role_change'
  | 'membership_suspended'
  | 'workspace_switch'
  | 'invitation_create'
  | 'invitation_accept';

export interface AuthUser {
  id: string;
  email: string;
  passwordHash: string;
  sessionVersion: number;
  createdAt: Date;
}

export interface WorkspaceRecord {
  id: string;
  slug: string;
  name: string;
}

export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: UserRole;
  state: MembershipState;
}

export interface WorkspaceSummary {
  id: string;
  type: 'personal' | 'school';
  name: string;
  role: UserRole;
}

export interface SessionRecord {
  id: string;
  userId: string;
  workspaceId: string;
  csrfToken: string;
  version: number;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}

export interface RecoveryTokenRecord {
  tokenHash: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface InvitationRecord {
  tokenHash: string;
  email: string;
  workspaceId: string;
  role: UserRole;
  state: InvitationState;
  expiresAt: Date;
  acceptedBy?: string | null;
}

export interface AuditEventRecord {
  action: AuditAction;
  userId: string | null;
  workspaceId: string | null;
  occurredAt: Date;
}

export interface RateLimitRecord {
  key: string;
  count: number;
  windowStartedAt: Date;
}

export interface AuthStore {
  getUserByEmail(email: string): Promise<AuthUser | null>;
  getUserById(id: string): Promise<AuthUser | null>;
  saveUser(user: AuthUser): Promise<void>;
  saveWorkspace(workspace: WorkspaceRecord): Promise<void>;
  getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null>;
  saveMembership(membership: WorkspaceMembership): Promise<void>;
  getMembership(userId: string, workspaceId: string): Promise<WorkspaceMembership | null>;
  listMemberships(userId: string): Promise<WorkspaceMembership[]>;
  saveSession(session: SessionRecord): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  revokeSession(id: string): Promise<void>;
  revokeSessionsForUser(userId: string): Promise<void>;
  saveRecoveryToken(token: RecoveryTokenRecord): Promise<void>;
  getRecoveryToken(tokenHash: string): Promise<RecoveryTokenRecord | null>;
  consumeRecoveryToken(tokenHash: string, consumedAt: Date): Promise<void>;
  saveInvitation(invitation: InvitationRecord): Promise<void>;
  getInvitation(tokenHash: string): Promise<InvitationRecord | null>;
  saveAudit(event: AuditEventRecord): Promise<void>;
  countAudit(action: AuditAction): Promise<number>;
  getRateLimit(key: string): Promise<RateLimitRecord | null>;
  saveRateLimit(record: RateLimitRecord): Promise<void>;
  transaction<T>(fn: (store: AuthStore) => Promise<T>): Promise<T>;
  sendNotification?(input: NotificationSendInput): Promise<void>;
}

export interface AuthServiceOptions {
  store: AuthStore;
  now?: () => Date;
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  recoveryTokenTtlMs: number;
  inviteTokenTtlMs: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  appUrl?: string;
}

export class AuthService {
  private readonly store: AuthStore;
  private readonly now: () => Date;
  private readonly sessionIdleMs: number;
  private readonly sessionAbsoluteMs: number;
  private readonly recoveryTokenTtlMs: number;
  private readonly inviteTokenTtlMs: number;
  private readonly rateLimitWindowMs: number;
  private readonly rateLimitMax: number;
  private readonly appUrl: string;

  constructor(options: AuthServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.sessionIdleMs = options.sessionIdleMs;
    this.sessionAbsoluteMs = options.sessionAbsoluteMs;
    this.recoveryTokenTtlMs = options.recoveryTokenTtlMs;
    this.inviteTokenTtlMs = options.inviteTokenTtlMs;
    this.rateLimitWindowMs = options.rateLimitWindowMs;
    this.rateLimitMax = options.rateLimitMax;
    this.appUrl = stripTrailingSlash(options.appUrl ?? 'http://localhost:3000');
  }

  async register(input: { email: string; password: string }): Promise<{
    status: 'created' | 'accepted';
    message: string;
    userId: string;
    workspaceId: string;
  }> {
    const email = normalizeEmail(input.email);
    if (!email || !input.password) {
      throw this.validationError('Email dan kata sandi tidak valid.');
    }
    const existing = await this.store.getUserByEmail(email);
    if (existing) {
      const existingWorkspace = await this.ensureActiveWorkspaceContext(existing);
      return {
        status: 'accepted',
        message: 'Jika pendaftaran dapat diproses, instruksi berikutnya akan dikirim.',
        userId: existing.id,
        workspaceId: existingWorkspace,
      };
    }

    const now = this.now();
    const userId = randomUUID();
    let workspaceId = '';
    await this.store.transaction(async (tx) => {
      await tx.saveUser({
        id: userId,
        email,
        passwordHash: hashSecret(input.password),
        sessionVersion: 1,
        createdAt: now,
      });
      workspaceId = await this.createPersonalWorkspace(tx, { id: userId, email });
      await tx.saveAudit({ action: 'register', userId, workspaceId, occurredAt: now });
    });

    return {
      status: 'created',
      message: 'Akun berhasil dibuat.',
      userId,
      workspaceId,
    };
  }

  async login(input: { email: string; password: string }): Promise<{ session: SessionRecord }> {
    const user = await this.store.getUserByEmail(normalizeEmail(input.email));
    if (!user || user.passwordHash !== hashSecret(input.password)) {
      throw this.validationError('Email atau kata sandi tidak valid.');
    }

    const workspaceId = await this.firstWorkspaceId(user.id);
    if (!workspaceId) {
      throw this.validationError('Workspace tidak ditemukan.');
    }

    await this.store.revokeSessionsForUser(user.id);
    const session = await this.issueSession(user.id, workspaceId, user.sessionVersion);
    await this.store.saveAudit({
      action: 'login',
      userId: user.id,
      workspaceId,
      occurredAt: this.now(),
    });
    return { session };
  }

  async logout(input: { sessionId: string }): Promise<void> {
    const session = await this.requireSession(input.sessionId);
    await this.store.revokeSession(session.id);
    await this.store.saveAudit({
      action: 'logout',
      userId: session.userId,
      workspaceId: session.workspaceId,
      occurredAt: this.now(),
    });
  }

  async logoutAll(input: { userId: string }): Promise<void> {
    const user = await this.mustUser(input.userId);
    user.sessionVersion += 1;
    await this.store.saveUser(user);
    await this.store.revokeSessionsForUser(user.id);
    await this.store.saveAudit({
      action: 'logout_all',
      userId: user.id,
      workspaceId: null,
      occurredAt: this.now(),
    });
  }

  async requestRecovery(input: { email: string }): Promise<{ message: string }> {
    const email = normalizeEmail(input.email);
    await this.bumpRateLimit(`recovery:${email}`);
    const now = this.now();
    const user = await this.store.getUserByEmail(email);
    if (!user) {
      return { message: 'Jika akun ditemukan, instruksi pemulihan akan dikirim.' };
    }

    const recoveryToken = `recovery_${randomUUID()}`;
    try {
      await this.store.transaction(async (tx) => {
        await tx.saveRecoveryToken({
          tokenHash: hashSecret(recoveryToken),
          userId: user.id,
          expiresAt: new Date(now.getTime() + this.recoveryTokenTtlMs),
          consumedAt: null,
        });
        await tx.saveAudit({
          action: 'recovery_request',
          userId: user.id,
          workspaceId: null,
          occurredAt: now,
        });
        await tx.sendNotification?.({
          templateKey: 'auth.recovery',
          locale: 'id-ID',
          recipient: { kind: 'email', value: user.email },
          payload: { code: recoveryToken },
          eventId: randomUUID(),
        });
      });
    } catch {
      return { message: 'Jika akun ditemukan, instruksi pemulihan akan dikirim.' };
    }

    return { message: 'Jika akun ditemukan, instruksi pemulihan akan dikirim.' };
  }

  async completeRecovery(input: {
    token: string;
    newPassword: string;
  }): Promise<{ session: SessionRecord }> {
    const token = await this.requireUsableRecoveryToken(input.token);
    const user = await this.mustUser(token.userId);
    user.passwordHash = hashSecret(input.newPassword);
    user.sessionVersion += 1;
    await this.store.saveUser(user);
    await this.store.consumeRecoveryToken(token.tokenHash, this.now());
    await this.store.revokeSessionsForUser(user.id);
    const workspaceId = await this.firstWorkspaceId(user.id);
    if (!workspaceId) {
      throw this.validationError('Workspace tidak ditemukan.');
    }
    const session = await this.issueSession(user.id, workspaceId, user.sessionVersion);
    await this.store.saveAudit({
      action: 'recovery_complete',
      userId: user.id,
      workspaceId,
      occurredAt: this.now(),
    });
    return { session };
  }

  async createSchoolInvitation(input: {
    email: string;
    role: UserRole;
    workspaceId: string;
    createdByUserId: string;
  }): Promise<{ tokenHash: string }> {
    if (!USER_ROLES.includes(input.role)) {
      throw this.validationError('Role tidak valid.');
    }
    const membership = await this.store.getMembership(input.createdByUserId, input.workspaceId);
    if (
      !membership ||
      membership.state !== 'active' ||
      !hasPermission(membership.role, PERMISSIONS.workspaceMemberManage)
    ) {
      throw new ApiError({
        code: 'PERMISSION_DENIED',
        message: 'Permintaan tidak diizinkan.',
        requestId: 'req_auth',
      });
    }

    const creator = await this.mustUser(input.createdByUserId);
    const workspace = await this.store.getWorkspace(input.workspaceId);
    const token = `invite_${randomUUID()}`;
    const tokenHash = hashSecret(token);
    await this.store.transaction(async (tx) => {
      await tx.saveInvitation({
        tokenHash,
        email: normalizeEmail(input.email),
        workspaceId: input.workspaceId,
        role: input.role,
        state: 'pending',
        expiresAt: new Date(this.now().getTime() + this.inviteTokenTtlMs),
      });
      await tx.saveAudit({
        action: 'invitation_create',
        userId: input.createdByUserId,
        workspaceId: input.workspaceId,
        occurredAt: this.now(),
      });
      await tx.sendNotification?.({
        templateKey: 'workspace.invite',
        locale: 'id-ID',
        recipient: { kind: 'email', value: normalizeEmail(input.email) },
        payload: {
          inviter_name: creator.email,
          workspace_name: workspace?.name ?? input.workspaceId,
          accept_url: `${this.appUrl}/auth/invitations/consume?token=${encodeURIComponent(token)}`,
        },
        eventId: randomUUID(),
      });
    });
    return { tokenHash };
  }

  async consumeSchoolInvitation(input: { token: string; password: string }): Promise<{
    userId: string;
    workspaceId: string;
  }> {
    const invitation = await this.requireUsableInvitation(input.token);
    let user = await this.store.getUserByEmail(invitation.email);
    if (!user) {
      user = {
        id: randomUUID(),
        email: invitation.email,
        passwordHash: hashSecret(input.password),
        sessionVersion: 1,
        createdAt: this.now(),
      };
      await this.store.saveUser(user);
    }
    await this.store.saveMembership({
      workspaceId: invitation.workspaceId,
      userId: user.id,
      role: invitation.role,
      state: 'active',
    });
    invitation.state = 'accepted';
    invitation.acceptedBy = user.id;
    await this.store.saveInvitation(invitation);
    await this.store.saveAudit({
      action: 'invitation_accept',
      userId: user.id,
      workspaceId: invitation.workspaceId,
      occurredAt: this.now(),
    });
    return { userId: user.id, workspaceId: invitation.workspaceId };
  }

  async suspendMembership(input: { userId: string; workspaceId: string }): Promise<void> {
    const membership = await this.store.getMembership(input.userId, input.workspaceId);
    if (!membership) {
      throw new ApiError({
        code: 'WORKSPACE_ACCESS_DENIED',
        message: 'Workspace tidak ditemukan.',
        requestId: 'req_auth',
        status: 404,
      });
    }
    membership.state = 'suspended';
    await this.store.saveMembership(membership);
    const user = await this.mustUser(input.userId);
    user.sessionVersion += 1;
    await this.store.saveUser(user);
    await this.store.revokeSessionsForUser(user.id);
    await this.store.saveAudit({
      action: 'membership_suspended',
      userId: user.id,
      workspaceId: input.workspaceId,
      occurredAt: this.now(),
    });
  }

  async switchWorkspace(input: {
    sessionId: string;
    workspaceId: string;
  }): Promise<{ activeWorkspaceId: string }> {
    const session = await this.requireSession(input.sessionId);
    const membership = await this.store.getMembership(session.userId, input.workspaceId);
    if (!membership || membership.state !== 'active') {
      throw new ApiError({
        code: 'WORKSPACE_ACCESS_DENIED',
        message: 'Workspace tidak ditemukan.',
        requestId: 'req_auth',
        status: 404,
      });
    }
    session.workspaceId = input.workspaceId;
    await this.store.saveSession(session);
    await this.store.saveAudit({
      action: 'workspace_switch',
      userId: session.userId,
      workspaceId: input.workspaceId,
      occurredAt: this.now(),
    });
    return { activeWorkspaceId: input.workspaceId };
  }

  async currentContext(sessionId: string): Promise<{
    userId: string;
    activeWorkspaceId: string;
    workspaceIds: string[];
    workspaces: WorkspaceSummary[];
  }> {
    const session = await this.requireSession(sessionId);
    const memberships = (await this.store.listMemberships(session.userId)).filter(
      (membership) => membership.state === 'active',
    );
    const workspaces = (
      await Promise.all(
        memberships.map(async (membership) => {
          const workspace = await this.store.getWorkspace(membership.workspaceId);
          if (!workspace) return null;
          return {
            id: workspace.id,
            type: workspace.slug.startsWith('personal-') ? 'personal' : 'school',
            name: workspace.name,
            role: membership.role,
          } satisfies WorkspaceSummary;
        }),
      )
    ).filter((workspace): workspace is WorkspaceSummary => workspace !== null);
    return {
      userId: session.userId,
      activeWorkspaceId: session.workspaceId,
      workspaceIds: workspaces.map((workspace) => workspace.id),
      workspaces,
    };
  }

  async currentAccount(sessionId: string): Promise<{
    account: { id: string; displayName: string };
    workspaces: WorkspaceSummary[];
    activeWorkspaceId: string;
  }> {
    const context = await this.currentContext(sessionId);
    const user = await this.mustUser(context.userId);
    return {
      account: {
        id: user.id,
        displayName: user.email,
      },
      workspaces: context.workspaces,
      activeWorkspaceId: context.activeWorkspaceId,
    };
  }

  async requireSession(sessionId: string): Promise<SessionRecord> {
    const session = await this.store.getSession(sessionId);
    if (!session || session.revokedAt) {
      throw this.authRequired();
    }
    const now = this.now();
    if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) {
      await this.store.revokeSession(session.id);
      throw this.authRequired();
    }
    const user = await this.mustUser(session.userId);
    if (session.version !== user.sessionVersion) {
      await this.store.revokeSession(session.id);
      throw this.authRequired();
    }
    const membership = await this.store.getMembership(session.userId, session.workspaceId);
    if (!membership || membership.state !== 'active') {
      await this.store.revokeSession(session.id);
      throw this.authRequired();
    }
    return session;
  }

  async auditCount(action: AuditAction): Promise<number> {
    return this.store.countAudit(action);
  }

  private async issueSession(
    userId: string,
    workspaceId: string,
    version: number,
  ): Promise<SessionRecord> {
    const now = this.now();
    const session: SessionRecord = {
      id: randomUUID(),
      userId,
      workspaceId,
      csrfToken: `csrf_${randomUUID()}`,
      version,
      idleExpiresAt: new Date(now.getTime() + this.sessionIdleMs),
      absoluteExpiresAt: new Date(now.getTime() + this.sessionAbsoluteMs),
      revokedAt: null,
    };
    await this.store.saveSession(session);
    return session;
  }

  private async firstWorkspaceId(userId: string): Promise<string | null> {
    const membership = (await this.store.listMemberships(userId)).find(
      (item) => item.state === 'active',
    );
    return membership?.workspaceId ?? null;
  }

  private async ensureActiveWorkspaceContext(user: AuthUser): Promise<string> {
    return this.store.transaction(async (tx) => {
      const existingWorkspaceId = await tx
        .listMemberships(user.id)
        .then(
          (memberships) =>
            memberships.find((membership) => membership.state === 'active')?.workspaceId ?? null,
        );
      if (existingWorkspaceId) return existingWorkspaceId;
      return this.createPersonalWorkspace(tx, user);
    });
  }

  private async createPersonalWorkspace(
    store: AuthStore,
    user: Pick<AuthUser, 'id' | 'email'>,
  ): Promise<string> {
    const workspaceId = randomUUID();
    await store.saveWorkspace({
      id: workspaceId,
      slug: `personal-${workspaceId.slice(0, 12)}`,
      name: `Workspace ${user.email}`,
    });
    await store.saveMembership({
      workspaceId,
      userId: user.id,
      role: 'teacher',
      state: 'active',
    });
    return workspaceId;
  }

  private async mustUser(id: string): Promise<AuthUser> {
    const user = await this.store.getUserById(id);
    if (!user) {
      throw this.authRequired();
    }
    return user;
  }

  private async requireUsableRecoveryToken(token: string): Promise<RecoveryTokenRecord> {
    const record = await this.store.getRecoveryToken(hashSecret(token));
    if (!record || record.consumedAt || record.expiresAt <= this.now()) {
      throw this.validationError('Token pemulihan tidak valid.');
    }
    return record;
  }

  private async requireUsableInvitation(token: string): Promise<InvitationRecord> {
    const invitation = await this.store.getInvitation(hashSecret(token));
    if (!invitation || invitation.state !== 'pending' || invitation.expiresAt <= this.now()) {
      throw this.validationError('Undangan tidak valid.');
    }
    return invitation;
  }

  private async bumpRateLimit(key: string): Promise<void> {
    const now = this.now();
    const current = await this.store.getRateLimit(key);
    if (!current || now.getTime() - current.windowStartedAt.getTime() >= this.rateLimitWindowMs) {
      await this.store.saveRateLimit({ key, count: 1, windowStartedAt: now });
      return;
    }
    if (current.count >= this.rateLimitMax) {
      throw new ApiError({
        code: 'RATE_LIMITED',
        message: 'Terlalu banyak permintaan. Coba lagi nanti.',
        requestId: 'req_auth',
        status: 429,
      });
    }
    current.count += 1;
    await this.store.saveRateLimit(current);
  }

  private validationError(message: string): ApiError {
    return new ApiError({
      code: 'VALIDATION_FAILED',
      message,
      requestId: 'req_auth',
      status: 400,
    });
  }

  private authRequired(): ApiError {
    return new ApiError({
      code: 'AUTH_REQUIRED',
      message: 'Autentikasi diperlukan.',
      requestId: 'req_auth',
      status: 401,
    });
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
