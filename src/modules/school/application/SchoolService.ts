/**
 * B7-01 — School service.
 *
 * Orchestrates school workspace creation, invitation (one-time token),
 * and member management. Delegates invitation mechanics to AuthService.
 */
import { randomBytes, createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

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
  findByTokenHash(tokenHash: string): Promise<{
    tokenHash: string;
    email: string;
    workspaceId: string;
    tenantId: string;
    role: string;
    state: string;
    expiresAt: Date;
  } | null>;
  markAccepted(tokenHash: string, userId: string): Promise<void>;
  saveMember(tenantId: string, workspaceId: string, member: SchoolMember): Promise<void>;
  saveUser(id: string, email: string, passwordHash: string): Promise<{ id: string; email: string }>;
  getUserByEmail(email: string): Promise<{ id: string; email: string; passwordHash: string } | null>;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hashPassword(password: string): string {
  // Simple hash for test layer — production uses bcrypt via AuthService
  return createHash('sha256').update(password).digest('hex');
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

  async acceptInvitation(input: AcceptInvitationInput): Promise<AcceptInvitationResult> {
    const tokenHash = hashToken(input.token);
    const invitation = await this.invitationStore.findByTokenHash(tokenHash);

    if (!invitation) {
      throw new InvalidInvitationError('Invitation not found or already used.');
    }
    if (invitation.state !== 'pending') {
      throw new InvalidInvitationError(`Invitation is ${invitation.state}.`);
    }
    if (invitation.expiresAt <= this.clock()) {
      throw new InvalidInvitationError('Invitation has expired.');
    }

    // Find or create user
    let user = await this.invitationStore.getUserByEmail(invitation.email);
    if (!user) {
      const id = randomUUID();
      user = await this.invitationStore.saveUser(
        id,
        invitation.email,
        hashPassword(input.password),
      ) as { id: string; email: string; passwordHash: string };
    }

    // Add member to workspace
    await this.invitationStore.saveMember(invitation.tenantId, invitation.workspaceId, {
      id: user.id,
      email: user.email,
      role: invitation.role as SchoolMember['role'],
      state: 'active',
      joinedAt: this.clock().toISOString(),
    });

    // Mark invitation as accepted (one-time use)
    await this.invitationStore.markAccepted(tokenHash, user.id);

    return { userId: user.id, workspaceId: invitation.workspaceId };
  }

  async listMembers(tenantId: string, workspaceId: string): Promise<SchoolMember[]> {
    return this.workspaceStore.listMembers(tenantId, workspaceId);
  }
}

export class InvalidInvitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInvitationError';
  }
}
