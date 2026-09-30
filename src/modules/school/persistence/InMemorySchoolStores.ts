/**
 * In-memory school stores — enough to wire school + dashboard routes.
 */
import { randomUUID } from 'node:crypto';

import type {
  SchoolInvitationStore,
  SchoolInvitationRecord,
  SchoolWorkspaceStore,
  NewInvitedUser,
} from '../application/SchoolService.js';
import { UsernameTakenError } from '../application/SchoolService.js';
import type { SchoolMember, SchoolWorkspace } from '../domain/types.js';

export class InMemorySchoolWorkspaceStore implements SchoolWorkspaceStore {
  private workspaces = new Map<string, SchoolWorkspace>();
  private members = new Map<string, SchoolMember[]>(); // key: tenantId:workspaceId

  async createWorkspace(
    tenantId: string,
    name: string,
    level: string,
  ): Promise<SchoolWorkspace> {
    const workspace: SchoolWorkspace = {
      id: randomUUID(),
      tenantId,
      name,
      level,
      createdAt: new Date().toISOString(),
    };
    this.workspaces.set(`${tenantId}:${workspace.id}`, workspace);
    this.members.set(`${tenantId}:${workspace.id}`, []);
    return workspace;
  }

  async getWorkspace(tenantId: string, workspaceId: string): Promise<SchoolWorkspace | null> {
    return this.workspaces.get(`${tenantId}:${workspaceId}`) ?? null;
  }

  async listMembers(tenantId: string, workspaceId: string): Promise<SchoolMember[]> {
    return [...(this.members.get(`${tenantId}:${workspaceId}`) ?? [])];
  }

  async updateMemberRole(
    tenantId: string,
    workspaceId: string,
    memberId: string,
    role: SchoolMember['role'],
  ): Promise<SchoolMember | null> {
    const key = `${tenantId}:${workspaceId}`;
    const list = this.members.get(key) ?? [];
    const idx = list.findIndex((m) => m.id === memberId);
    if (idx === -1) return null;
    const existing = list[idx] as SchoolMember;
    const updated: SchoolMember = {
      id: existing.id,
      email: existing.email,
      role,
      state: existing.state,
      joinedAt: existing.joinedAt,
    };
    list[idx] = updated;
    this.members.set(key, list);
    return updated;
  }

  async removeMember(
    tenantId: string,
    workspaceId: string,
    memberId: string,
  ): Promise<boolean> {
    const key = `${tenantId}:${workspaceId}`;
    const list = this.members.get(key) ?? [];
    const idx = list.findIndex((m) => m.id === memberId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    this.members.set(key, list);
    return true;
  }

  /** Seed helper used by bootstrap for demo dashboard. */
  seedWorkspace(workspace: SchoolWorkspace, members: SchoolMember[] = []): void {
    this.workspaces.set(`${workspace.tenantId}:${workspace.id}`, workspace);
    this.members.set(`${workspace.tenantId}:${workspace.id}`, members);
  }
}

type InvitationRecord = {
  tokenHash: string;
  email: string;
  workspaceId: string;
  tenantId: string;
  role: string;
  state: string;
  expiresAt: Date;
};

export class InMemorySchoolInvitationStore implements SchoolInvitationStore {
  private invitations = new Map<string, InvitationRecord>();
  private users = new Map<string, { id: string; email: string; passwordHash: string }>();
  private members = new Map<string, SchoolMember[]>();
  /** Every username ever handed out, so collisions behave like the DB's unique index. */
  private usernames = new Set<string>();

  async saveInvitation(record: InvitationRecord): Promise<void> {
    this.invitations.set(record.tokenHash, { ...record, state: record.state || 'pending' });
  }

  async findByTokenHash(tokenHash: string): Promise<SchoolInvitationRecord | null> {
    return this.invitations.get(tokenHash) ?? null;
  }

  async markAccepted(tokenHash: string, userId: string): Promise<boolean> {
    const inv = this.invitations.get(tokenHash);
    if (!inv || inv.state !== 'pending') return false;
    this.invitations.set(tokenHash, { ...inv, state: 'accepted' });
    void userId;
    return true;
  }

  async saveMember(tenantId: string, workspaceId: string, member: SchoolMember): Promise<void> {
    const key = `${tenantId}:${workspaceId}`;
    const list = this.members.get(key) ?? [];
    if (!list.some((existing) => existing.id === member.id)) list.push(member);
    this.members.set(key, list);
  }

  async createUser(
    user: NewInvitedUser,
  ): Promise<{ id: string; email: string; username: string }> {
    if (this.usernames.has(user.username.toLowerCase())) {
      throw new UsernameTakenError(`Username ${user.username} sudah dipakai`);
    }
    this.usernames.add(user.username.toLowerCase());
    this.users.set(user.email.toLowerCase(), {
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
    });
    return { id: user.id, email: user.email, username: user.username };
  }

  async getUserByEmail(
    email: string,
  ): Promise<{ id: string; email: string; passwordHash: string } | null> {
    return this.users.get(email.toLowerCase()) ?? null;
  }

  /** No real rollback needed in memory — the semantics are already atomic. */
  async transaction<T>(fn: (store: SchoolInvitationStore) => Promise<T>): Promise<T> {
    return fn(this);
  }
}
