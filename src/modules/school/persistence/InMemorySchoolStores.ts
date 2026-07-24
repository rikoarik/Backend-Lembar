/**
 * In-memory school stores — enough to wire school + dashboard routes.
 */
import { randomUUID } from 'node:crypto';

import type {
  SchoolInvitationStore,
  SchoolWorkspaceStore,
} from '../application/SchoolService.js';
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

  async saveInvitation(record: InvitationRecord): Promise<void> {
    this.invitations.set(record.tokenHash, { ...record, state: record.state || 'pending' });
  }

  async findByTokenHash(tokenHash: string): Promise<InvitationRecord | null> {
    return this.invitations.get(tokenHash) ?? null;
  }

  async markAccepted(tokenHash: string, userId: string): Promise<void> {
    const inv = this.invitations.get(tokenHash);
    if (!inv) return;
    this.invitations.set(tokenHash, { ...inv, state: 'accepted' });
    void userId;
  }

  async saveMember(tenantId: string, workspaceId: string, member: SchoolMember): Promise<void> {
    const key = `${tenantId}:${workspaceId}`;
    const list = this.members.get(key) ?? [];
    list.push(member);
    this.members.set(key, list);
  }

  async saveUser(
    id: string,
    email: string,
    passwordHash: string,
  ): Promise<{ id: string; email: string }> {
    const user = { id, email, passwordHash };
    this.users.set(email.toLowerCase(), user);
    return { id, email };
  }

  async getUserByEmail(
    email: string,
  ): Promise<{ id: string; email: string; passwordHash: string } | null> {
    return this.users.get(email.toLowerCase()) ?? null;
  }
}
