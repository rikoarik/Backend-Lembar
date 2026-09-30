/**
 * BUG-20b — accepting a school invitation for a brand-new email.
 *
 * The bug was `PostgresSchoolStores.saveUser()` inserting only
 * (id, email, password_hash, created_at) into `jwt_users`, whose `name`,
 * `username` and `roles` columns are NOT NULL → every accept returned 500.
 *
 * The fake store below re-declares those NOT NULL constraints so the regression
 * cannot come back unnoticed: if the service ever stops filling a column, the
 * insert throws here exactly like Postgres would.
 */
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';

import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';
import { SchoolService } from '../../../src/modules/school/application/SchoolService.js';
import { registerSchoolRoutes } from '../../../src/modules/school/adapters/http/schoolRoutes.js';
import type {
  SchoolInvitationStore,
  SchoolInvitationRecord,
  NewInvitedUser,
  SchoolWorkspaceStore,
} from '../../../src/modules/school/application/SchoolService.js';
import { UsernameTakenError } from '../../../src/modules/school/application/SchoolService.js';
import { USERNAME_PATTERN } from '../../../src/modules/school/domain/inviteIdentity.js';
import type { SchoolMember, SchoolWorkspace } from '../../../src/modules/school/domain/types.js';

const WS = 'ws-school-bug20b';
const TENANT = 'tenant-school-bug20b';
const JWT_SECRET = 'bug20b-secret';
const VALID_PASSWORD = 'Aud20bInvite!9x';

/** Mirrors the live `jwt_users` shape closely enough to catch a NOT NULL miss. */
interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  username: string;
  roles: string[];
  workspaceId: string | null;
}

class FakeWorkspaceStore implements SchoolWorkspaceStore {
  members = new Map<string, SchoolMember[]>();

  async createWorkspace(tenantId: string, name: string, level: string): Promise<SchoolWorkspace> {
    return { id: WS, tenantId, name, level, createdAt: new Date().toISOString() };
  }
  async getWorkspace(): Promise<SchoolWorkspace | null> {
    return null;
  }
  async listMembers(tenantId: string, workspaceId: string): Promise<SchoolMember[]> {
    return [...(this.members.get(`${tenantId}:${workspaceId}`) ?? [])];
  }
  async updateMemberRole(): Promise<SchoolMember | null> {
    return null;
  }
  async removeMember(): Promise<boolean> {
    return false;
  }
}

class FakeInvitationStore implements SchoolInvitationStore {
  invitations = new Map<string, SchoolInvitationRecord & { acceptedBy: string | null }>();
  users: UserRow[] = [];
  /** Records what the service asked for, so assertions can inspect the row. */
  lastCreatedUser: NewInvitedUser | null = null;

  constructor(private readonly workspaceStore: FakeWorkspaceStore) {}

  async saveInvitation(record: {
    tokenHash: string;
    email: string;
    workspaceId: string;
    tenantId: string;
    role: string;
    state: string;
    expiresAt: Date;
  }): Promise<void> {
    this.invitations.set(record.tokenHash, { ...record, acceptedBy: null });
  }

  async findByTokenHash(tokenHash: string): Promise<SchoolInvitationRecord | null> {
    return this.invitations.get(tokenHash) ?? null;
  }

  async markAccepted(tokenHash: string, userId: string): Promise<boolean> {
    const inv = this.invitations.get(tokenHash);
    if (!inv || inv.state !== 'pending') return false;
    this.invitations.set(tokenHash, { ...inv, state: 'accepted', acceptedBy: userId });
    return true;
  }

  async saveMember(tenantId: string, workspaceId: string, member: SchoolMember): Promise<void> {
    const key = `${tenantId}:${workspaceId}`;
    const list = this.workspaceStore.members.get(key) ?? [];
    list.push(member);
    this.workspaceStore.members.set(key, list);
    // Membership also lives on the user row, as `workspace_id` does in Postgres.
    const row = this.users.find((candidate) => candidate.id === member.id);
    if (row) row.workspaceId = workspaceId;
  }

  async createUser(user: NewInvitedUser): Promise<{ id: string; email: string; username: string }> {
    // The three columns BUG-20b failed to populate.
    if (!user.name) throw new Error('null value in column "name" of relation "jwt_users"');
    if (!user.username) throw new Error('null value in column "username" of relation "jwt_users"');
    if (!user.roles || user.roles.length === 0) {
      throw new Error('null value in column "roles" of relation "jwt_users"');
    }
    if (!USERNAME_PATTERN.test(user.username)) {
      throw new Error(`username "${user.username}" violates jwt_users_username_check`);
    }
    if (this.users.some((row) => row.username === user.username)) {
      throw new UsernameTakenError(`Username ${user.username} sudah dipakai`);
    }
    if (this.users.some((row) => row.email === user.email)) {
      throw new Error('duplicate key value violates unique constraint "jwt_users_email_unique"');
    }
    this.lastCreatedUser = user;
    this.users.push({
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      name: user.name,
      username: user.username,
      roles: [...user.roles],
      workspaceId: null,
    });
    return { id: user.id, email: user.email, username: user.username };
  }

  async getUserByEmail(email: string): Promise<{ id: string; email: string; passwordHash: string } | null> {
    const row = this.users.find((candidate) => candidate.email === email);
    if (!row) return null;
    return { id: row.id, email: row.email, passwordHash: row.passwordHash };
  }

  async transaction<T>(fn: (store: SchoolInvitationStore) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

async function buildApp(clock?: () => Date) {
  const workspaceStore = new FakeWorkspaceStore();
  const invitationStore = new FakeInvitationStore(workspaceStore);
  const service = new SchoolService(workspaceStore, invitationStore, clock);

  const app = Fastify({ logger: false });
  await app.register((instance) =>
    registerSchoolRoutes(instance, { service, jwtSecret: JWT_SECRET }),
  );
  await app.ready();
  return { app, service, invitationStore };
}

const adminHeaders = () => ({
  authorization: `Bearer ${generateJwt(
    { userId: 'admin-1', email: 'admin@school.test', roles: ['school_admin'], workspaceId: WS },
    { secret: JWT_SECRET, expiryDays: 1 },
  )}`,
  'content-type': 'application/json',
});

async function invite(app: Awaited<ReturnType<typeof buildApp>>['app'], email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/invitations',
    headers: adminHeaders(),
    body: JSON.stringify({ workspaceId: WS, email, role: 'teacher' }),
  });
  expect(res.statusCode).toBe(201);
  return res.json().data.token as string;
}

const accept = (app: Awaited<ReturnType<typeof buildApp>>['app'], token: string, password: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/invitations/accept',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password }),
  });

describe('BUG-20b — accept invitation for a new email', () => {
  it('creates a complete jwt_users row, grants membership and burns the token', async () => {
    const { app, invitationStore } = await buildApp();
    const token = await invite(app, 'budi.santoso@school.test');

    const res = await accept(app, token, VALID_PASSWORD);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.workspaceId).toBe(WS);
    expect(body.data.userId).toMatch(/^[0-9a-f-]{36}$/);

    // jwt_users row is complete — the NOT NULL columns are filled.
    expect(invitationStore.users).toHaveLength(1);
    const user = invitationStore.users[0]!;
    expect(user.name).toBe('Budi Santoso');
    expect(user.username).toMatch(USERNAME_PATTERN);
    expect(user.roles).toEqual(['teacher']);
    expect(user.workspaceId).toBe(WS);
    expect(user.passwordHash).not.toBe(VALID_PASSWORD);
    expect(user.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt, not sha256

    // Membership visible through the workspace store.
    const members = await app.inject({
      method: 'GET',
      url: `/v1/school/${WS}/members`,
      headers: adminHeaders(),
    });
    expect(members.statusCode).toBe(200);
    expect(members.json().data.map((m: SchoolMember) => m.email)).toContain('budi.santoso@school.test');

    // Invitation flipped to accepted with accepted_by recorded.
    const stored = [...invitationStore.invitations.values()][0]!;
    expect(stored.state).toBe('accepted');
    expect(stored.acceptedBy).toBe(user.id);
  });

  it('derives a unique username when the email local part is already taken', async () => {
    const { app, invitationStore } = await buildApp();
    // Same local part, different domain → same derived base username.
    await accept(app, await invite(app, 'sama@sekolah-a.test'), VALID_PASSWORD);
    await accept(app, await invite(app, 'sama@sekolah-b.test'), VALID_PASSWORD);

    expect(invitationStore.users).toHaveLength(2);
    const usernames = invitationStore.users.map((row) => row.username);
    expect(new Set(usernames).size).toBe(2);
    for (const username of usernames) expect(username).toMatch(USERNAME_PATTERN);
  });

  it('replay of the same token → 404 RESOURCE_NOT_FOUND', async () => {
    const { app, invitationStore } = await buildApp();
    const token = await invite(app, 'sekali@school.test');

    expect((await accept(app, token, VALID_PASSWORD)).statusCode).toBe(200);

    const replay = await accept(app, token, VALID_PASSWORD);
    expect(replay.statusCode).toBe(404);
    expect(replay.json().error.code).toBe('RESOURCE_NOT_FOUND');

    // No second user, no second membership.
    expect(invitationStore.users).toHaveLength(1);
  });

  it('expired token → 410 INVITATION_EXPIRED, distinguishable from an unknown token', async () => {
    // A mutable clock lets the invite be issued "now" and consumed 8 days later
    // on the very same app instance.
    let now = new Date('2026-01-01T00:00:00Z');
    const { app, invitationStore } = await buildApp(() => now);
    const token = await invite(app, 'kadaluarsa@school.test');

    now = new Date('2026-01-09T00:00:00Z'); // past the 7-day TTL

    const expired = await accept(app, token, VALID_PASSWORD);
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error.code).toBe('INVITATION_EXPIRED');
    expect(expired.json().error.message).toMatch(/kedaluwarsa/i);
    // An expired attempt must not create the account or burn the token.
    expect(invitationStore.users).toHaveLength(0);
    expect([...invitationStore.invitations.values()][0]!.state).toBe('pending');

    const unknown = await accept(app, 'token-yang-tidak-pernah-ada', VALID_PASSWORD);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('RESOURCE_NOT_FOUND');
    expect(unknown.json().error.message).not.toMatch(/kedaluwarsa/i);
  });

  it('enforces the same password policy as /v1/auth/register', async () => {
    const { app, invitationStore } = await buildApp();
    const token = await invite(app, 'lemah@school.test');

    for (const weak of ['pendek1!A', 'tanpahurufbesar1!', 'TanpaAngka!xx', 'TanpaSimbol12345']) {
      const res = await accept(app, token, weak);
      expect(res.statusCode, `password ${weak}`).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
      expect(res.json().error.message).toMatch(/minimal 12 karakter/i);
    }

    // A rejected password must not consume the invitation.
    expect(invitationStore.users).toHaveLength(0);
    expect([...invitationStore.invitations.values()][0]!.state).toBe('pending');

    // The same token still works with a compliant password.
    expect((await accept(app, token, VALID_PASSWORD)).statusCode).toBe(200);
  });

  it('missing token or password → 400', async () => {
    const { app } = await buildApp();
    expect((await accept(app, '', VALID_PASSWORD)).statusCode).toBe(400);
  });
});

describe('BUG-20a — invitation preview', () => {
  it('reports pending for a fresh token and used after acceptance', async () => {
    const { app } = await buildApp();
    const token = await invite(app, 'pratinjau@school.test');

    const preview = await app.inject({
      method: 'GET',
      url: `/v1/invitations/preview?token=${token}`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.status).toBe('pending');
    expect(preview.json().data.email).toBe('pratinjau@school.test');
    expect(preview.json().data.role).toBe('teacher');

    await accept(app, token, VALID_PASSWORD);

    const after = await app.inject({
      method: 'GET',
      url: `/v1/invitations/preview?token=${token}`,
    });
    expect(after.json().data.status).toBe('used');
  });

  it('reports invalid for an unknown token without leaking existence', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/invitations/preview?token=nope' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('invalid');
    expect(res.json().data.email).toBeNull();
  });

  it('requires the token query parameter', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/invitations/preview' });
    expect(res.statusCode).toBe(400);
  });
});
