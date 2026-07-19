import { describe, expect, test } from 'vitest';

import { AuthService, type AuthStore } from '../../../src/modules/auth/application/AuthService.js';
import { InMemoryAuthStore } from '../../../src/modules/auth/adapters/persistence/InMemoryAuthStore.js';

function buildService(store: AuthStore = new InMemoryAuthStore()): AuthService {
  return new AuthService({
    store,
    now: () => new Date('2026-07-19T10:00:00.000Z'),
    sessionIdleMs: 30 * 60 * 1000,
    sessionAbsoluteMs: 8 * 60 * 60 * 1000,
    recoveryTokenTtlMs: 15 * 60 * 1000,
    inviteTokenTtlMs: 60 * 60 * 1000,
    rateLimitWindowMs: 60_000,
    rateLimitMax: 2,
  });
}

describe('AuthService', () => {
  test('registers a user with personal workspace and uses enumeration-safe duplicate response', async () => {
    const service = buildService();

    const first = await service.register({
      email: ' Teacher@Example.test ',
      password: 'passphrase-1',
    });
    const second = await service.register({
      email: 'teacher@example.test',
      password: 'passphrase-1',
    });

    expect(first.status).toBe('created');
    expect(second.status).toBe('accepted');
    expect(second.message).toBe(
      'Jika pendaftaran dapat diproses, instruksi berikutnya akan dikirim.',
    );
    expect(await service.auditCount('register')).toBe(1);
  });

  test('login rotates session id and logout revokes the session', async () => {
    const service = buildService();
    await service.register({ email: 'teacher@example.test', password: 'passphrase-1' });

    const first = await service.login({ email: 'teacher@example.test', password: 'passphrase-1' });
    const second = await service.login({ email: 'teacher@example.test', password: 'passphrase-1' });
    await service.logout({ sessionId: second.session.id });

    expect(first.session.id).not.toBe(second.session.id);
    await expect(service.requireSession(second.session.id)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    expect(await service.auditCount('login')).toBe(2);
    expect(await service.auditCount('logout')).toBe(1);
  });

  test('recovery is generic, single-use, and revokes older sessions', async () => {
    const service = buildService();
    await service.register({ email: 'teacher@example.test', password: 'passphrase-1' });
    const before = await service.login({ email: 'teacher@example.test', password: 'passphrase-1' });

    const request = await service.requestRecovery({ email: 'teacher@example.test' });
    const after = await service.completeRecovery({
      token: request.debugToken,
      newPassword: 'passphrase-2',
    });

    expect(request.message).toBe('Jika akun ditemukan, instruksi pemulihan akan dikirim.');
    expect(after.session.id).not.toBe(before.session.id);
    await expect(service.requireSession(before.session.id)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    await expect(
      service.completeRecovery({ token: request.debugToken, newPassword: 'passphrase-3' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await service.auditCount('recovery_complete')).toBe(1);
  });

  test('logout all and membership suspension revoke by version check', async () => {
    const service = buildService();
    const registered = await service.register({
      email: 'teacher@example.test',
      password: 'passphrase-1',
    });
    const login = await service.login({ email: 'teacher@example.test', password: 'passphrase-1' });

    await service.logoutAll({ userId: registered.userId });
    await expect(service.requireSession(login.session.id)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });

    const after = await service.login({ email: 'teacher@example.test', password: 'passphrase-1' });
    await service.suspendMembership({
      userId: registered.userId,
      workspaceId: registered.workspaceId,
    });
    await expect(service.requireSession(after.session.id)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    await expect(
      service.switchWorkspace({ sessionId: after.session.id, workspaceId: registered.workspaceId }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  test('school invitation token is hashed, single-use, and replay-rejected', async () => {
    const service = buildService();
    const admin = await service.register({ email: 'admin@example.test', password: 'passphrase-1' });
    const invite = await service.createSchoolInvitation({
      email: 'teacher@example.test',
      role: 'teacher',
      workspaceId: admin.workspaceId,
      createdByUserId: admin.userId,
    });

    const accepted = await service.consumeSchoolInvitation({
      token: invite.debugToken,
      password: 'passphrase-2',
    });

    expect(invite.tokenHash).not.toContain(invite.debugToken);
    expect(accepted.workspaceId).toBe(admin.workspaceId);
    await expect(
      service.consumeSchoolInvitation({ token: invite.debugToken, password: 'passphrase-3' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  test('rate limits repeated recovery requests without leaking account existence', async () => {
    const service = buildService();

    await service.requestRecovery({ email: 'missing@example.test' });
    await service.requestRecovery({ email: 'missing@example.test' });

    await expect(service.requestRecovery({ email: 'missing@example.test' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
});
