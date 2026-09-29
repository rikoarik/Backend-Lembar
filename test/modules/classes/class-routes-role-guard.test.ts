/**
 * BUG-04 defense-in-depth — /v1/classes role guard.
 *
 * FE BFF sudah menolak non-school role, tetapi BFF bisa dilewati (backend
 * dipanggil langsung via curl/Swagger). Karena itu backend sendiri harus
 * menolak teacher/subscriber pada seluruh 6 route kelas.
 *
 * Evidence:
 * - teacher/subscriber token → 403 PERMISSION_DENIED di POST /v1/classes
 *   (dan di 5 route kelas lainnya) tanpa menyentuh DB.
 * - school_admin/superadmin tetap lolos (201/200).
 * - WHERE workspace_id tetap dipakai (tidak ada regresi lintas workspace).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const getPool = vi.hoisted(() => vi.fn());
vi.mock('../../../src/infrastructure/database/db.js', () => ({ getPool }));

import { registerClassRoutes } from '../../../src/modules/classes/adapters/http/classRoutes.js';
import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';

const JWT_SECRET = 'class-route-guard-test-secret';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const CLASS_ID = '44444444-4444-4444-8444-444444444444';

type Role = 'superadmin' | 'school_admin' | 'teacher' | 'subscriber';

interface RecordedQuery {
  text: string;
  values: unknown[];
}

/** Pool palsu: mencatat query, membalas suspensi + hasil per-statement. */
function makePool(calls: RecordedQuery[]) {
  return {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      if (text.includes('suspended_at')) return { rows: [{ suspended: false }] };
      if (text.trim().toUpperCase().startsWith('INSERT')) {
        return { rows: [{ id: CLASS_ID, name: 'Kelas A', studentCount: 0 }] };
      }
      if (text.trim().toUpperCase().startsWith('DELETE')) return { rows: [{ id: CLASS_ID }] };
      return { rows: [] };
    }),
  };
}

function buildApp(calls: RecordedQuery[]): FastifyInstance {
  getPool.mockReturnValue(makePool(calls));
  const app = Fastify({ logger: false });
  void registerClassRoutes(app, { db: {} as never, jwtSecret: JWT_SECRET });
  return app;
}

function token(roles: Role[], workspaceId: string | null = WORKSPACE_ID) {
  return generateJwt(
    { userId: USER_ID, email: 'user@example.test', roles, workspaceId },
    { secret: JWT_SECRET, expiryDays: 1 },
  );
}

function auth(roles: Role[], workspaceId: string | null = WORKSPACE_ID) {
  return {
    authorization: `Bearer ${token(roles, workspaceId)}`,
    'content-type': 'application/json',
  };
}

const NON_SCHOOL_ROLES: Role[] = ['teacher', 'subscriber'];

const ALL_CLASS_ROUTES: Array<{ method: 'GET' | 'POST' | 'DELETE'; url: string }> = [
  { method: 'GET', url: '/v1/classes' },
  { method: 'POST', url: '/v1/classes' },
  { method: 'GET', url: `/v1/classes/${CLASS_ID}/students` },
  { method: 'POST', url: `/v1/classes/${CLASS_ID}/students` },
  { method: 'DELETE', url: `/v1/classes/${CLASS_ID}` },
  { method: 'DELETE', url: `/v1/classes/${CLASS_ID}/students/${CLASS_ID}` },
];

describe('BUG-04 — /v1/classes role guard (backend, bukan hanya BFF)', () => {
  for (const role of NON_SCHOOL_ROLES) {
    for (const route of ALL_CLASS_ROUTES) {
      it(`${role} ditolak 403 pada ${route.method} ${route.url}`, async () => {
        const calls: RecordedQuery[] = [];
        const app = buildApp(calls);
        const response = await app.inject({
          method: route.method,
          url: route.url,
          headers: auth([role]),
          payload: { name: 'Kelas Terlarang' },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('PERMISSION_DENIED');
        // Guard jalan sebelum handler: tidak ada statement domain yang dieksekusi.
        const domainQueries = calls.filter((call) => !call.text.includes('suspended_at'));
        expect(domainQueries).toEqual([]);
        await app.close();
      });
    }
  }

  it('teacher ditolak 403 pada POST /v1/classes (acceptance: curl/Swagger langsung ke backend)', async () => {
    const app = buildApp([]);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/classes',
      headers: auth(['teacher']),
      payload: { name: 'Kelas Guru', gradeLabel: 'X', schoolYear: '2026/2027' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('PERMISSION_DENIED');
    await app.close();
  });

  it('user dengan role ganda teacher+school_admin tetap lolos', async () => {
    const app = buildApp([]);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/classes',
      headers: auth(['teacher', 'school_admin']),
      payload: { name: 'Kelas Campuran' },
    });

    expect(response.statusCode).toBe(201);
    await app.close();
  });

  for (const role of ['school_admin', 'superadmin'] as const) {
    it(`${role} tetap bisa membuat kelas (201)`, async () => {
      const app = buildApp([]);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/classes',
        headers: auth([role]),
        payload: { name: 'Kelas Baru', gradeLabel: 'XI', schoolYear: '2026/2027' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().data.id).toBe(CLASS_ID);
      await app.close();
    });
  }

  it('token tanpa role sama sekali ditolak 403 (bukan 500)', async () => {
    const app = buildApp([]);
    const response = await app.inject({ method: 'GET', url: '/v1/classes', headers: auth([]) });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('PERMISSION_DENIED');
    await app.close();
  });

  it('tanpa token tetap 401 (auth dulu, lalu role)', async () => {
    const app = buildApp([]);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/classes',
      payload: { name: 'x' },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('school_admin tetap workspace-scoped (tidak ada regresi lintas workspace)', async () => {
    const calls: RecordedQuery[] = [];
    const app = buildApp(calls);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/classes',
      headers: auth(['school_admin']),
    });
    expect(list.statusCode).toBe(200);

    const create = await app.inject({
      method: 'POST',
      url: '/v1/classes',
      headers: auth(['school_admin']),
      payload: { name: 'Kelas Scoped' },
    });
    expect(create.statusCode).toBe(201);

    const students = await app.inject({
      method: 'GET',
      url: `/v1/classes/${CLASS_ID}/students`,
      headers: auth(['school_admin']),
    });
    expect(students.statusCode).toBe(200);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/v1/classes/${CLASS_ID}`,
      headers: { authorization: auth(['school_admin']).authorization },
    });
    expect(remove.statusCode).toBe(204);

    const domainQueries = calls.filter((call) => !call.text.includes('suspended_at'));
    expect(domainQueries).toHaveLength(4);
    const whereQueries = domainQueries.filter((call) => /WHERE/i.test(call.text));
    expect(whereQueries).toHaveLength(3);
    for (const call of whereQueries) {
      expect(call.text).toMatch(/workspace_id\s*=\s*\$\d+/);
      expect(call.values).toContain(WORKSPACE_ID);
      expect(call.values).not.toContain(OTHER_WORKSPACE_ID);
    }
    // INSERT kelas tetap memakai workspace JWT, bukan input klien.
    const insert = domainQueries.find((call) =>
      call.text.trim().toUpperCase().startsWith('INSERT'),
    );
    expect(insert?.values[0]).toBe(WORKSPACE_ID);
    expect(insert?.values).not.toContain(OTHER_WORKSPACE_ID);
    await app.close();
  });
});
