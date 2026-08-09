import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';
import { registerCatalogRoutes } from '../../../src/modules/catalog/adapters/http/catalogRoutes.js';

const SECRET = 'catalog-tenant-test-secret';
const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const token = generateJwt(
  { userId: 'user', email: 'user@example.test', roles: ['teacher'], workspaceId: TENANT },
  { secret: SECRET, expiryDays: 1 },
);

const rows = {
  grades: [
    { id: 'own-grade', label: 'Own grade', publishedVersion: 1, tenantId: TENANT },
    { id: 'other-grade', label: 'Gate grade', publishedVersion: 1, tenantId: OTHER },
  ],
  subjects: [
    { id: 'own-subject', label: 'Own subject', publishedVersion: 1, tenantId: TENANT },
    { id: 'other-subject', label: 'Other subject', publishedVersion: 1, tenantId: OTHER },
  ],
  materials: [
    { id: 'own-material', label: 'Own material', publishedVersion: 1, tenantId: TENANT },
    { id: 'other-material', label: 'Other material', publishedVersion: 1, tenantId: OTHER },
  ],
};

function database(table: keyof typeof rows) {
  return {
    select: () => ({
      from: () => ({ where: (_condition: unknown) => rows[table] }),
    }),
  };
}

async function request(url: string, authorization?: string) {
  const app = Fastify();
  const table = url.includes('/subjects')
    ? 'subjects'
    : url.includes('/materials')
      ? 'materials'
      : 'grades';
  await registerCatalogRoutes(app, { db: database(table) as never, jwtSecret: SECRET });
  const response = await app.inject({
    method: 'GET',
    url,
    headers: authorization ? { authorization } : {},
  });
  await app.close();
  return response;
}

describe('catalog tenant isolation', () => {
  it('never exposes tenant rows to public callers', async () => {
    expect(
      (await request('/v1/catalog/grades'))
        .json()
        .data.some((row: { id: string }) => row.id === 'other-grade'),
    ).toBe(false);
  });

  it.each([
    ['/v1/catalog/grades', 'own-grade', 'other-grade'],
    ['/v1/catalog/subjects?gradeId=own-grade', 'own-subject', 'other-subject'],
    [
      '/v1/catalog/materials?gradeId=own-grade&subjectId=own-subject&curriculumVersionId=curriculum',
      'own-material',
      'other-material',
    ],
  ])('returns only JWT tenant rows for %s', async (url, own, other) => {
    const response = await request(url, `Bearer ${token}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((row: { id: string }) => row.id)).toContain(own);
    expect(response.json().data.map((row: { id: string }) => row.id)).not.toContain(other);
  });

  it('rejects an invalid JWT instead of treating it as public', async () => {
    expect((await request('/v1/catalog/grades', 'Bearer invalid')).statusCode).toBe(401);
  });
});
