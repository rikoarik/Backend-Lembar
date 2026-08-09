import { describe, expect, it, vi } from 'vitest';

const query = vi.fn().mockResolvedValue({ rows: [] });

vi.mock('../../../src/infrastructure/database/db.js', () => ({
  getPool: () => ({ query }),
}));

import { PostgresSchoolInvitationStore } from '../../../src/modules/school/persistence/PostgresSchoolStores.js';

describe('PostgresSchoolInvitationStore', () => {
  it('persists invitations using the live tenant-scoped schema', async () => {
    const store = new PostgresSchoolInvitationStore({} as never);

    await store.saveInvitation({
      tokenHash: 'hash',
      email: 'teacher@school.id',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      tenantId: '11111111-1111-4111-8111-111111111111',
      role: 'teacher',
      state: 'pending',
      expiresAt: new Date('2026-08-16T00:00:00.000Z'),
    });

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain(
      '(id, tenant_id, email, role, state, token_hash, expires_at, created_at)',
    );
    expect(sql).not.toContain('workspace_id');
    expect(values).toEqual([
      '11111111-1111-4111-8111-111111111111',
      'teacher@school.id',
      'teacher',
      'pending',
      'hash',
      new Date('2026-08-16T00:00:00.000Z'),
    ]);
  });

  it('reads the workspace identity from tenant_id', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          token_hash: 'hash',
          email: 'teacher@school.id',
          workspace_id: 'tenant-1',
          tenant_id: 'tenant-1',
          role: 'teacher',
          state: 'pending',
          expires_at: new Date('2026-08-16T00:00:00.000Z'),
        },
      ],
    });
    const store = new PostgresSchoolInvitationStore({} as never);

    const invitation = await store.findByTokenHash('hash');

    expect(query.mock.calls.at(-1)![0]).toContain('tenant_id AS workspace_id');
    expect(invitation?.workspaceId).toBe('tenant-1');
  });
});
