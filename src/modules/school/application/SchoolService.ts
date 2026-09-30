/**
 * B7-01 — School service.
 *
 * Orchestrates school workspace creation, invitation (one-time token),
 * and member management. Delegates invitation mechanics to AuthService.
 */
import { randomBytes, createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import type { UserRole } from '../../../infrastructure/database/schema.js';
import { hashPassword } from '../../auth/infrastructure/password.js';
import {
  isPasswordCompliant,
  PASSWORD_POLICY_MESSAGE,
} from '../../auth/policy/passwordPolicy.js';
import {
  deriveDisplayName,
  deriveUsernameBase,
  usernameCandidate,
} from '../domain/inviteIdentity.js';
import type {
  SchoolWorkspace,
  SchoolMember,
  SchoolInvitationInput,
  SchoolInvitationResult,
  AcceptInvitationInput,
  AcceptInvitationResult,
} from '../domain/types.js';

export interface SchoolWorkspaceStore {
  createWorkspace(tenantId: string, name: string, level: string): Promise<SchoolWorkspace>;
  getWorkspace(tenantId: string, workspaceId: string): Promise<SchoolWorkspace | null>;
  listMembers(tenantId: string, workspaceId: string): Promise<SchoolMember[]>;
  updateMemberRole(tenantId: string, workspaceId: string, memberId: string, role: SchoolMember['role']): Promise<SchoolMember | null>;
  removeMember(tenantId: string, workspaceId: string, memberId: string): Promise<boolean>;
}

/** Invitation state as stored in `auth_school_invitations.state`. */
export type SchoolInvitationState = 'pending' | 'accepted' | 'expired' | 'revoked';

export interface SchoolInvitationRecord {
  tokenHash: string;
  email: string;
  workspaceId: string;
  tenantId: string;
  role: string;
  state: string;
  expiresAt: Date;
}

/**
 * Account row created when an invited email has no account yet.
 *
 * `jwt_users` requires `name`, `username` and `roles` NOT NULL, so the caller
 * must supply all three — that is exactly what BUG-20b was missing.
 */
export interface NewInvitedUser {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  username: string;
  roles: UserRole[];
}

export interface SchoolInvitationStore {
  saveInvitation(record: {
    tokenHash: string;
    email: string;
    workspaceId: string;
    tenantId: string;
    role: string;
    state: string;
    expiresAt: Date;
  }): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<SchoolInvitationRecord | null>;
  /**
   * Flips a still-pending invitation to accepted. Returns false when the row
   * was no longer pending (concurrent/replayed accept) — the caller must treat
   * that as a one-time-token violation, not a success.
   */
  markAccepted(tokenHash: string, userId: string): Promise<boolean>;
  /** Grants workspace membership: workspace pointer + role on the account row. */
  saveMember(tenantId: string, workspaceId: string, member: SchoolMember): Promise<void>;
  /** Inserts a complete `jwt_users` row. Throws `UsernameTakenError` on collision. */
  createUser(user: NewInvitedUser): Promise<{ id: string; email: string; username: string }>;
  getUserByEmail(email: string): Promise<{ id: string; email: string; passwordHash: string } | null>;
  /** Runs `fn` against a store whose writes commit or roll back together. */
  transaction<T>(fn: (store: SchoolInvitationStore) => Promise<T>): Promise<T>;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Bounded retries when the derived username is already taken. */
const USERNAME_ATTEMPTS = 8;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Roles an invitation may grant; anything else is a data error, not a user error. */
function normalizeInvitationRole(role: string): UserRole {
  if (role === 'school_admin' || role === 'teacher' || role === 'superadmin' || role === 'subscriber') {
    return role;
  }
  throw new InvalidInvitationError('Undangan tidak valid.');
}

export class SchoolService {
  constructor(
    private readonly workspaceStore: SchoolWorkspaceStore,
    private readonly invitationStore: SchoolInvitationStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async createWorkspace(
    tenantId: string,
    name: string,
    level: string,
  ): Promise<SchoolWorkspace> {
    return this.workspaceStore.createWorkspace(tenantId, name, level);
  }

  async createInvitation(input: SchoolInvitationInput): Promise<SchoolInvitationResult> {
    // Generate high-entropy one-time token (32 bytes = 64 hex chars)
    const token = randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(this.clock().getTime() + INVITE_TTL_MS);

    await this.invitationStore.saveInvitation({
      tokenHash,
      email: input.email.toLowerCase().trim(),
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      role: input.role,
      state: 'pending',
      expiresAt,
    });

    return {
      token, // Return raw token ONCE — never stored
      tokenHash,
      email: input.email,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Accepts an invitation: creates the account when the email is new, grants
   * workspace membership, and burns the token.
   *
   * The whole mutation runs in one transaction so a failure can never leave a
   * user without membership or an invitation burned without a user. The
   * `state = 'pending'` guard on `markAccepted` makes the token one-time even
   * under concurrent requests.
   */
  async acceptInvitation(input: AcceptInvitationInput): Promise<AcceptInvitationResult> {
    const tokenHash = hashToken(input.token);
    const invitation = await this.invitationStore.findByTokenHash(tokenHash);

    if (!invitation) {
      throw new InvalidInvitationError('Undangan tidak ditemukan atau sudah digunakan.');
    }
    if (invitation.state === 'pending' && invitation.expiresAt <= this.clock()) {
      // Distinguishable from "unknown/used" so the client can ask for a new link
      // instead of showing a dead-end "not found".
      throw new ExpiredInvitationError('Undangan sudah kedaluwarsa.');
    }
    if (invitation.state !== 'pending') {
      throw new InvalidInvitationError('Undangan tidak ditemukan atau sudah digunakan.');
    }
    if (!isPasswordCompliant(input.password)) {
      throw new WeakPasswordError(PASSWORD_POLICY_MESSAGE);
    }

    const role = normalizeInvitationRole(invitation.role);
    const passwordHash = await hashPassword(input.password);

    return this.invitationStore.transaction(async (store) => {
      let user = await store.getUserByEmail(invitation.email);
      if (!user) {
        const created = await this.createInvitedAccount(store, invitation.email, passwordHash, role);
        user = { id: created.id, email: created.email, passwordHash };
      }

      // Burn the token first: if it was already consumed, nothing else runs.
      const burned = await store.markAccepted(tokenHash, user.id);
      if (!burned) {
        throw new InvalidInvitationError('Undangan tidak ditemukan atau sudah digunakan.');
      }

      await store.saveMember(invitation.tenantId, invitation.workspaceId, {
        id: user.id,
        email: user.email,
        role,
        state: 'active',
        joinedAt: this.clock().toISOString(),
      });

      return { userId: user.id, workspaceId: invitation.workspaceId };
    });
  }

  /**
   * Read-only invitation state for the activation page. Deliberately answers
   * 200 for every token (including unknown ones) so the endpoint cannot be used
   * to enumerate valid invitation tokens.
   */
  async previewInvitation(token: string): Promise<{
    status: 'pending' | 'expired' | 'used' | 'invalid';
    email: string | null;
    role: string | null;
    expiresAt: string | null;
  }> {
    const invitation = await this.invitationStore.findByTokenHash(hashToken(token));
    if (!invitation) {
      return { status: 'invalid', email: null, role: null, expiresAt: null };
    }

    const expiresAt = invitation.expiresAt.toISOString();
    if (invitation.state === 'accepted') {
      return { status: 'used', email: invitation.email, role: invitation.role, expiresAt };
    }
    if (invitation.state === 'revoked' || invitation.state === 'expired') {
      return { status: 'invalid', email: invitation.email, role: invitation.role, expiresAt };
    }
    if (invitation.expiresAt <= this.clock()) {
      return { status: 'expired', email: invitation.email, role: invitation.role, expiresAt };
    }
    return { status: 'pending', email: invitation.email, role: invitation.role, expiresAt };
  }

  /**
   * Retries username derivation until the database accepts one. The invitee
   * never chose a username, so a collision must not surface as a 500.
   */
  private async createInvitedAccount(
    store: SchoolInvitationStore,
    email: string,
    passwordHash: string,
    role: UserRole,
  ): Promise<{ id: string; email: string; username: string }> {
    const name = deriveDisplayName(email);
    const base = deriveUsernameBase(email);

    for (let attempt = 0; attempt < USERNAME_ATTEMPTS; attempt += 1) {
      const username = usernameCandidate(base, attempt);
      try {
        return await store.createUser({
          id: randomUUID(),
          email,
          passwordHash,
          name,
          username,
          roles: [role],
        });
      } catch (error) {
        if (error instanceof UsernameTakenError) continue;
        throw error;
      }
    }

    throw new UsernameTakenError(`Tidak dapat membuat username unik untuk ${email}`);
  }

  async listMembers(tenantId: string, workspaceId: string): Promise<SchoolMember[]> {
    return this.workspaceStore.listMembers(tenantId, workspaceId);
  }

  async updateMemberRole(
    tenantId: string,
    workspaceId: string,
    memberId: string,
    role: SchoolMember['role'],
  ): Promise<SchoolMember | null> {
    return this.workspaceStore.updateMemberRole(tenantId, workspaceId, memberId, role);
  }

  async removeMember(
    tenantId: string,
    workspaceId: string,
    memberId: string,
  ): Promise<boolean> {
    return this.workspaceStore.removeMember(tenantId, workspaceId, memberId);
  }
}

export class InvalidInvitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInvitationError';
  }
}

/** Token exists but is past `expires_at` — the client should request a new one. */
export class ExpiredInvitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpiredInvitationError';
  }
}

/** Password rejected by the shared register/invite policy. */
export class WeakPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

/** `jwt_users.username` is unique — the store signals a collision with this. */
export class UsernameTakenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsernameTakenError';
  }
}
