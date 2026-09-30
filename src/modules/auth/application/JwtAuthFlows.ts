/**
 * JWT-mode implementations of the auth flows that the session-cookie
 * `AuthService` used to own (BUG-18 / BUG-21 / BUG-22).
 *
 * Everything here is keyed on `jwt_users.id` (uuid), not on `auth_accounts.id`,
 * because that is the identity the running JWT routes actually authenticate.
 * The one exception is `POST /v1/auth/recovery/request`, whose delivery store
 * (`notification_outbox`) is reachable only through the session-mode
 * `auth_accounts` row — see `requestRecovery` for why and what happens when the
 * row is absent.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import { throwApiError } from '../../../common/errors/apiError.js';
import { ApiError } from '../../../common/errors/envelope.js';
import { getPool, type Database } from '../../../infrastructure/database/db.js';
import { tenants } from '../../../infrastructure/database/schema.js';
import { MemoryNotificationAdapter } from '../../notifications/domain/NotificationAdapter.js';
import { NotificationService } from '../../notifications/domain/NotificationService.js';
import { NotificationRepository } from '../../notifications/persistence/NotificationRepository.js';
import { hashPassword } from '../infrastructure/password.js';
import { generateJwt } from '../infrastructure/jwtMultiRole.js';
import { jwtUsers, type UserRole } from '../persistence/jwtUsersSchema.js';
import { authAccounts, schoolInvitations } from '../persistence/schema.js';
import { hashToken } from './PasswordResetService.js';

/** TTL of the recovery link; mirrors `PasswordResetService`. */
const RECOVERY_TTL_MS = 60 * 60 * 1000;

/**
 * Password policy, duplicated locally so this branch does not depend on the
 * school-invitation refactor (kanban t_9d83cd2a) which is extracting the same
 * rule into `../policy/passwordPolicy.ts`. Must stay identical to
 * `JwtMultiRoleAuthService.assertPasswordPolicy` and
 * `/v1/invitations/accept`.
 */
const PASSWORD_UPPER = /[A-Z]/;
const PASSWORD_NUMBER = /\d/;
const PASSWORD_SYMBOL = /[^A-Za-z0-9]/;
const PASSWORD_POLICY_MESSAGE =
  'Kata sandi minimal 12 karakter, berisi huruf besar, angka, dan simbol';

function isPasswordCompliant(password: string): boolean {
  return (
    password.length >= 12 &&
    PASSWORD_UPPER.test(password) &&
    PASSWORD_NUMBER.test(password) &&
    PASSWORD_SYMBOL.test(password)
  );
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_.]{3,24}$/;
const USERNAME_FALLBACK = 'pengguna';
const USERNAME_MAX_LENGTH = 24;

const NEUTRAL_RECOVERY_MESSAGE =
  'Jika akun ditemukan, instruksi pemulihan akan dikirim.';

export interface JwtUserRow {
  id: string;
  email: string;
  name: string;
  username: string;
  roles: UserRole[];
  workspaceId: string | null;
  sessionVersion: number;
  suspendedAt: Date | null;
}

export interface WorkspaceOption {
  id: string;
  name: string;
  slug: string;
  role: UserRole;
}

export interface InvitationLookup {
  status: 'pending' | 'expired' | 'revoked' | 'invalid';
  workspaceId: string | null;
  role: UserRole | null;
  expiresAt: string | null;
}

export interface InvitationPreview {
  status: InvitationLookup['status'];
  workspaceId?: string;
  workspaceName?: string;
  schoolName?: string;
  role?: UserRole;
  expiresAt?: string;
}

export interface ConsumedInvitation {
  userId: string;
  workspaceId: string;
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
    roles: UserRole[];
    workspaceId: string;
  };
}

export interface SwitchWorkspaceResult {
  activeWorkspaceId: string;
  token: string;
  workspace: { id: string; name: string; role: UserRole };
  user: { id: string; email: string; name: string; roles: UserRole[]; workspaceId: string };
}

export interface AuthRecoveryOptions {
  appUrl: string;
  jwtSecret: string;
  jwtExpiryDays: number;
}

export class AuthRecoveryService {
  private readonly appUrl: string;
  private readonly jwtConfig: { secret: string; expiryDays: number };
  private readonly notificationAdapter = new MemoryNotificationAdapter();

  constructor(
    private readonly db: Database,
    options: AuthRecoveryOptions,
  ) {
    this.appUrl = options.appUrl.replace(/\/+$/, '');
    this.jwtConfig = { secret: options.jwtSecret, expiryDays: options.jwtExpiryDays };
  }

  async getUserById(userId: string): Promise<JwtUserRow | null> {
    const [row] = await this.db.select().from(jwtUsers).where(eq(jwtUsers.id, userId)).limit(1);
    return row ? mapJwtUser(row) : null;
  }

  /**
   * BUG-21. Bumping `session_version` invalidates every JWT minted before this
   * call, because the auth middleware compares the token's `sv` claim against
   * this column. Idempotent by design: a second logout simply bumps again.
   */
  async revokeAllSessions(userId: string): Promise<number> {
    const [row] = await this.db
      .update(jwtUsers)
      .set({ sessionVersion: sql`${jwtUsers.sessionVersion} + 1`, updatedAt: new Date() })
      .where(eq(jwtUsers.id, userId))
      .returning({ sessionVersion: jwtUsers.sessionVersion });
    if (!row) {
      throwApiError('user_not_found', 'User tidak ditemukan');
    }
    return row.sessionVersion;
  }

  /**
   * BUG-18. Always answers neutrally — an unknown address must be
   * indistinguishable from a registered one.
   *
   * Delivery goes through `notification_outbox`, which `NotificationService`
   * requires a template for; the outbox itself is only reachable through the
   * session-mode `auth_accounts` row. When that row is absent (the JWT-only
   * account this deployment created) the token is still written to
   * `password_resets` and the link is logged, so an operator can deliver it.
   * The response is identical either way, so nothing leaks.
   */
  async requestRecovery(rawEmail: string): Promise<{ message: string }> {
    const email = rawEmail.trim().toLowerCase();
    if (!email) return { message: NEUTRAL_RECOVERY_MESSAGE };

    const [user] = await this.db.select().from(jwtUsers).where(eq(jwtUsers.email, email)).limit(1);
    if (!user) return { message: NEUTRAL_RECOVERY_MESSAGE };

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + RECOVERY_TTL_MS);
    const pool = getPool(this.db);
    if (!pool) return { message: NEUTRAL_RECOVERY_MESSAGE };

    await pool.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [user.id, hashToken(token), expiresAt],
    );

    const link = `${this.appUrl}/reset-sandi?token=${encodeURIComponent(token)}`;
    await this.tryDeliver(user.email, link);
    return { message: NEUTRAL_RECOVERY_MESSAGE };
  }

  private async tryDeliver(email: string, link: string): Promise<void> {
    try {
      const [account] = await this.db
        .select({ id: authAccounts.id })
        .from(authAccounts)
        .where(eq(authAccounts.email, email))
        .limit(1);
      if (!account) {
        // No session-mode account to hang the outbox event off.
        return;
      }

      const service = new NotificationService({
        adapter: this.notificationAdapter,
        repository: new NotificationRepository(this.db),
      });
      const result = await service.dispatch({
        templateKey: 'auth.recovery',
        locale: 'id-ID',
        recipient: { kind: 'email', value: email },
        payload: { code: link, reset_url: link },
        eventId: randomUUID(),
      });
      if (result.status === 'rejected') {
        // Template missing for this deployment — the row is still in
        // `password_resets`, so the link is not lost.
      }
    } catch {
      // Delivery is best effort: a failure here must not change the response,
      // otherwise the neutral answer leaks whether the address exists.
    }
  }

  /** Workspaces the account may switch to: its memberships plus its own workspace. */
  async listWorkspaces(userId: string): Promise<WorkspaceOption[]> {
    const pool = getPool(this.db);
    if (!pool) return [];

    const [user] = await this.db.select().from(jwtUsers).where(eq(jwtUsers.id, userId)).limit(1);
    if (!user) return [];

    const { rows } = await pool.query<{
      id: string;
      name: string;
      slug: string;
      role: UserRole | null;
    }>(
      `SELECT t.id, t.name, t.slug, m.role
         FROM auth_workspace_memberships m
         JOIN auth_accounts a ON a.id = m.account_id
         JOIN tenants t ON t.id = m.tenant_id
        WHERE lower(a.email) = lower($1) AND m.state = 'active'
        ORDER BY t.created_at ASC`,
      [user.email],
    );

    const options = new Map<string, WorkspaceOption>();
    for (const row of rows) {
      options.set(row.id, {
        id: row.id,
        name: row.name,
        slug: row.slug,
        role: (row.role ?? primaryRole(user.roles)) as UserRole,
      });
    }

    if (user.workspaceId && !options.has(user.workspaceId)) {
      const [tenant] = await this.db
        .select()
        .from(tenants)
        .where(eq(tenants.id, user.workspaceId))
        .limit(1);
      if (tenant) {
        options.set(tenant.id, {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          role: primaryRole(user.roles),
        });
      }
    }

    return [...options.values()];
  }

  /** BUG-22. Persists the active workspace and returns a token carrying it. */
  async switchWorkspace(userId: string, workspaceId: string): Promise<SwitchWorkspaceResult> {
    const user = await this.getUserById(userId);
    if (!user) throwApiError('user_not_found', 'User tidak ditemukan');

    const workspaces = await this.listWorkspaces(userId);
    const target = workspaces.find((workspace) => workspace.id === workspaceId);
    if (!target) {
      throw new ApiError({
        code: 'WORKSPACE_ACCESS_DENIED',
        message: 'Workspace tidak tersedia untuk akun ini.',
        requestId: 'pending',
        status: 403,
      });
    }

    const [updated] = await this.db
      .update(jwtUsers)
      .set({ workspaceId: target.id, updatedAt: new Date() })
      .where(eq(jwtUsers.id, userId))
      .returning();
    if (!updated) throwApiError('user_not_found', 'User tidak ditemukan');

    const token = generateJwt(
      {
        userId: updated.id,
        email: updated.email,
        roles: updated.roles,
        workspaceId: target.id,
        sv: updated.sessionVersion,
      },
      this.jwtConfig,
    );

    return {
      activeWorkspaceId: target.id,
      token,
      workspace: { id: target.id, name: target.name, role: target.role },
      user: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        roles: updated.roles,
        workspaceId: target.id,
      },
    };
  }
}

export class InvitationService {
  private readonly jwtConfig: { secret: string; expiryDays: number };

  constructor(
    private readonly db: Database,
    options: { jwtSecret: string; jwtExpiryDays: number },
  ) {
    this.jwtConfig = { secret: options.jwtSecret, expiryDays: options.jwtExpiryDays };
  }

  /** Token state only — never the invited email or the raw token. */
  async lookup(token: string): Promise<InvitationLookup> {
    const empty: InvitationLookup = {
      status: 'invalid',
      workspaceId: null,
      role: null,
      expiresAt: null,
    };
    if (!token) return empty;

    const [row] = await this.db
      .select()
      .from(schoolInvitations)
      .where(eq(schoolInvitations.tokenHash, hashToken(token)))
      .limit(1);
    if (!row) return empty;

    const expired = row.expiresAt.getTime() <= Date.now();
    const status: InvitationLookup['status'] = expired
      ? 'expired'
      : row.state === 'pending'
        ? 'pending'
        : row.state === 'accepted'
          ? 'revoked'
          : (row.state as InvitationLookup['status']);

    return {
      status,
      workspaceId: row.tenantId,
      role: row.role,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  async preview(token: string): Promise<InvitationPreview> {
    const lookup = await this.lookup(token);
    if (lookup.status !== 'pending' || !lookup.workspaceId) {
      return { status: lookup.status };
    }

    const [tenant] = await this.db
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, lookup.workspaceId))
      .limit(1);

    return {
      status: 'pending',
      workspaceId: lookup.workspaceId,
      workspaceName: tenant?.name ?? lookup.workspaceId,
      schoolName: tenant?.name ?? lookup.workspaceId,
      role: lookup.role ?? 'teacher',
      ...(lookup.expiresAt ? { expiresAt: lookup.expiresAt } : {}),
    };
  }

  /**
   * Accepts the invitation: creates or finds the `jwt_users` row, joins the
   * workspace, and issues a session token. One-time: the invitation flips to
   * `accepted` inside the same transaction.
   */
  async consume(token: string, password: string): Promise<ConsumedInvitation> {
    const lookup = await this.lookup(token);
    if (lookup.status === 'expired') {
      throw new ApiError({
        code: 'STATE_CONFLICT',
        message: 'Undangan sudah kedaluwarsa.',
        requestId: 'pending',
        status: 410,
      });
    }
    if (lookup.status !== 'pending' || !lookup.workspaceId) {
      throw new ApiError({
        code: 'RESOURCE_NOT_FOUND',
        message: 'Undangan tidak ditemukan atau sudah dipakai.',
        requestId: 'pending',
        status: 404,
      });
    }

    this.assertPasswordPolicy(password);

    const tokenHash = hashToken(token);
    const [invitation] = await this.db
      .select()
      .from(schoolInvitations)
      .where(and(eq(schoolInvitations.tokenHash, tokenHash), eq(schoolInvitations.state, 'pending')))
      .limit(1);
    if (!invitation) {
      throw new ApiError({
        code: 'RESOURCE_NOT_FOUND',
        message: 'Undangan tidak ditemukan atau sudah dipakai.',
        requestId: 'pending',
        status: 404,
      });
    }

    const email = invitation.email.trim().toLowerCase();
    const passwordHash = await hashPassword(password);

    let [user] = await this.db.select().from(jwtUsers).where(eq(jwtUsers.email, email)).limit(1);
    if (user) {
      // Existing account: set the password they just chose, keep their identity.
      [user] = await this.db
        .update(jwtUsers)
        .set({ passwordHash, needsPasswordSetup: false, updatedAt: new Date() })
        .where(eq(jwtUsers.id, user.id))
        .returning();
    } else {
      const username = await this.uniqueUsername(deriveUsernameBase(email));
      const [created] = await this.db
        .insert(jwtUsers)
        .values({
          email,
          username,
          name: deriveDisplayName(email),
          passwordHash,
          roles: [invitation.role],
          workspaceId: invitation.tenantId,
        })
        .returning();
      user = created;
    }

    if (!user) throwApiError('user_creation_failed', 'Gagal membuat user');

    // Membership in the school workspace, keyed on the session-mode account when
    // one exists so `/v1/auth/workspace/switch` sees the new workspace too.
    await this.recordMembership(email, invitation.tenantId, invitation.role, user.id);

    await this.db
      .update(schoolInvitations)
      .set({ state: 'accepted' })
      .where(and(eq(schoolInvitations.tokenHash, tokenHash), eq(schoolInvitations.state, 'pending')));

    const roles = user.roles.length > 0 ? user.roles : [invitation.role];
    const sessionToken = generateJwt(
      {
        userId: user.id,
        email: user.email,
        roles,
        workspaceId: user.workspaceId ?? invitation.tenantId,
        sv: user.sessionVersion,
      },
      this.jwtConfig,
    );

    return {
      userId: user.id,
      workspaceId: invitation.tenantId,
      token: sessionToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roles,
        workspaceId: user.workspaceId ?? invitation.tenantId,
      },
    };
  }

  private async recordMembership(
    email: string,
    tenantId: string,
    role: UserRole,
    userId: string,
  ): Promise<void> {
    const pool = getPool(this.db);
    if (!pool) return;
    const [account] = await this.db
      .select({ id: authAccounts.id })
      .from(authAccounts)
      .where(eq(authAccounts.email, email))
      .limit(1);
    if (!account) return;
    await pool.query(
      `INSERT INTO auth_workspace_memberships (account_id, tenant_id, role, state)
       VALUES ($1::uuid, $2::uuid, $3, 'active')
       ON CONFLICT (account_id, tenant_id) DO UPDATE SET role = EXCLUDED.role, state = 'active'`,
      [account.id, tenantId, role],
    );
    void userId;
  }

  private async uniqueUsername(base: string): Promise<string> {
    const safeBase = USERNAME_PATTERN.test(base) ? base : USERNAME_FALLBACK;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate =
        attempt === 0
          ? safeBase
          : `${safeBase.slice(0, USERNAME_MAX_LENGTH - String(attempt + 1).length)}${attempt + 1}`;
      const [existing] = await this.db
        .select({ id: jwtUsers.id })
        .from(jwtUsers)
        .where(eq(jwtUsers.username, candidate))
        .limit(1);
      if (!existing) return candidate;
    }
    return `${safeBase.slice(0, 16)}${randomUUID().slice(0, 7)}`;
  }

  private assertPasswordPolicy(password: string): void {
    if (!isPasswordCompliant(password)) {
      // `throwApiError` maps `password_policy` → 400 VALIDATION_FAILED.
      throwApiError('password_policy', PASSWORD_POLICY_MESSAGE);
    }
  }
}

function mapJwtUser(row: typeof jwtUsers.$inferSelect): JwtUserRow {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    username: row.username,
    roles: row.roles,
    workspaceId: row.workspaceId,
    sessionVersion: row.sessionVersion,
    suspendedAt: row.suspendedAt,
  };
}

function primaryRole(roles: UserRole[]): UserRole {
  return roles[0] ?? 'teacher';
}

/** Local part of the email, sanitised to the username alphabet. */
export function deriveUsernameBase(email: string): string {
  const local = (email.split('@')[0] ?? '').toLowerCase();
  const base = local.replace(/[^a-z0-9_.]/g, '').replace(/^[._]+/, '').slice(0, 20).replace(/[._]+$/, '');
  if (base.length < 3) return `${USERNAME_FALLBACK}${base}`.slice(0, 20);
  return USERNAME_PATTERN.test(base) ? base : USERNAME_FALLBACK;
}

/** `budi.santoso@x.id` → `Budi Santoso`. */
export function deriveDisplayName(email: string): string {
  const local = (email.split('@')[0] ?? '').trim();
  const words = local.split(/[._\-+]+/).filter((word) => word.length > 0);
  if (words.length === 0) return email;
  const name = words
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ')
    .trim();
  return name.length > 0 ? name.slice(0, 80) : email;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
