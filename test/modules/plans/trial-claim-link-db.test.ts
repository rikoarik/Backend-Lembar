import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  closeDatabase,
  createDatabase,
  type Database,
} from '../../../src/infrastructure/database/db.js';
import {
  hashTrialClaimToken,
  TrialService,
} from '../../../src/modules/plans/application/TrialService.js';
import {
  TrialConflictError,
  TrialRepository,
} from '../../../src/modules/plans/persistence/trialRepository.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('one-time trial claim link persistence', () => {
  const now = new Date('2026-08-23T00:00:00.000Z');
  const rawToken = 'db-backed-one-time-token-with-at-least-32-characters';
  let pool: Pool;
  let db: Database;
  let workspaceId: string;
  let userId: string;

  beforeEach(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    db = createDatabase({ connectionString: DATABASE_URL! });
    workspaceId = randomUUID();
    userId = randomUUID();
    const suffix = userId.replaceAll('-', '').slice(0, 12);
    await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [
      workspaceId,
      `trial-${suffix}`,
      'Trial Workspace',
    ]);
    await pool.query(
      `INSERT INTO jwt_users
        (id, email, password_hash, name, roles, workspace_id, username, phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        userId,
        `trial-${suffix}@example.com`,
        'not-used-in-this-test',
        'Trial User',
        ['subscriber'],
        workspaceId,
        `trial_${suffix}`,
        `08${suffix
          .replace(/[^0-9]/g, '')
          .padEnd(10, '7')
          .slice(0, 10)}`,
      ],
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM trial_claim_links WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM trial_claims WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM jwt_users WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [workspaceId]);
    await pool.end();
    await closeDatabase(db);
  });

  it('stores only the hash and rejects replay after an atomic claim', async () => {
    const service = new TrialService(
      new TrialRepository(db),
      'database-test-pepper-long-enough',
      () => now,
      () => rawToken,
    );

    const issued = await service.issueClaimLink({ userId, workspaceId });
    const storedBeforeClaim = await pool.query<{
      token_hash: string;
      used_at: Date | null;
    }>(
      `SELECT token_hash, used_at FROM trial_claim_links
        WHERE user_id = $1 AND workspace_id = $2`,
      [userId, workspaceId],
    );

    expect(issued.token).toBe(rawToken);
    expect(storedBeforeClaim.rows[0]).toMatchObject({
      token_hash: hashTrialClaimToken(rawToken),
      used_at: null,
    });
    expect(JSON.stringify(storedBeforeClaim.rows[0])).not.toContain(rawToken);

    await service.claim({
      userId,
      workspaceId,
      claimToken: rawToken,
      deviceToken: 'db-test-device-token',
      ip: '127.0.0.1',
    });

    await expect(
      service.claim({
        userId,
        workspaceId,
        claimToken: rawToken,
        deviceToken: 'db-test-device-token',
        ip: '127.0.0.1',
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TrialConflictError && error.code === 'TRIAL_CLAIM_LINK_INVALID',
    );

    const result = await pool.query<{ claim_count: string; used_at: Date | null }>(
      `SELECT
         (SELECT count(*) FROM trial_claims WHERE workspace_id = $1) AS claim_count,
         (SELECT used_at FROM trial_claim_links WHERE workspace_id = $1) AS used_at`,
      [workspaceId],
    );
    expect(result.rows[0]?.claim_count).toBe('1');
    expect(result.rows[0]?.used_at).toBeInstanceOf(Date);
  });
});
