import { describe, expect, it, vi } from 'vitest';

import {
  retryJobAtomically,
  retryJobsBulkAtomically,
} from '../../../src/modules/admin/application/jobRetry.js';

type QueryResult = { rowCount?: number | null; rows: Array<Record<string, string>> };

function poolWith(...responses: QueryResult[]) {
  return {
    query: vi.fn(async () => responses.shift() ?? { rowCount: 0, rows: [] }),
  } as any;
}

describe('admin job retry transitions', () => {
  it('uses a status-conditional update so a racing second retry cannot increment twice', async () => {
    const pool = poolWith({ rowCount: 1, rows: [{ id: 'job-1' }] }, { rowCount: 0, rows: [] });

    await expect(retryJobAtomically(pool, 'job-1')).resolves.toBe(true);
    await expect(retryJobAtomically(pool, 'job-1')).resolves.toBe(false);

    const [statement, params] = pool.query.mock.calls[0] as [string, string[]];
    expect(statement).toContain("status IN ('failed', 'dead_letter')");
    expect(statement).toContain('attempt = attempt + 1');
    expect(params).toEqual(['job-1']);
  });

  it('bulk retries only failed/dead-letter jobs using row locks and honors q/status filters', async () => {
    const pool = poolWith({ rows: [{ retried: '2' }] });

    await expect(retryJobsBulkAtomically(pool, { status: 'dead_letter', q: 'export' })).resolves.toEqual({
      retried: 2,
      skipped: 0,
    });

    const [statement, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(statement).toContain('FOR UPDATE SKIP LOCKED');
    expect(statement).toContain("status IN ('failed', 'dead_letter')");
    expect(statement).toContain('sj.status IN (\'failed\', \'dead_letter\')');
    expect(params).toEqual(['dead_letter', '%export%']);
  });
});
