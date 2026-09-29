/**
 * `GET /v1/catalog/materials` must expose `outcomeId` so the BFF can attribute
 * generated blueprint items to a curriculum outcome without reverse-engineering
 * the material id shape (kanban t_0728adef).
 *
 * Two branches are covered:
 *   - DB branch: tenant materials keyed by uuid → `outcomeId` is the uuid of
 *     `materials.outcome_id`.
 *   - official branch: Kemendikdasmen snapshot → `outcomeId` is `<subjectId>-cp`.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerCatalogRoutes } from '../../../src/modules/catalog/adapters/http/catalogRoutes.js';
import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';

const SECRET = 'catalog-materials-outcome-secret';
const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const OUTCOME_ID = '3f9d1c2e-4b7a-4d5f-9c11-8a2b6d4e7f01';

const token = generateJwt(
  { userId: 'user', email: 'user@example.test', roles: ['teacher'], workspaceId: TENANT },
  { secret: SECRET, expiryDays: 1 },
);

const MATERIAL_URL =
  '/v1/catalog/materials?gradeId=grade-1&subjectId=subject-1&curriculumVersionId=curriculum-1';

/** Minimal Drizzle-shaped stub: `db.select(...).from(...).where(...)` → rows. */
function database(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({ where: (_condition: unknown) => rows }),
    }),
  };
}

async function getMaterials(rows: unknown[] | null) {
  const app = Fastify();
  await registerCatalogRoutes(app, {
    db: rows ? (database(rows) as never) : undefined,
    jwtSecret: SECRET,
  });
  const response = await app.inject({
    method: 'GET',
    url: MATERIAL_URL,
    headers: { authorization: `Bearer ${token}` },
  });
  await app.close();
  return response;
}

describe('GET /v1/catalog/materials outcomeId', () => {
  it('exposes the owning outcome of a published tenant material from the DB branch', async () => {
    const response = await getMaterials([
      {
        id: 'aa914143-89ef-4a31-922e-ac753aa6f41e',
        label: 'Pecahan sederhana',
        outcomeId: OUTCOME_ID,
        publishedVersion: 1,
        tenantId: TENANT,
      },
      {
        id: 'bb914143-89ef-4a31-922e-ac753aa6f41e',
        label: 'Materi tenant lain',
        outcomeId: 'ffffffff-1111-2222-3333-444444444444',
        publishedVersion: 1,
        tenantId: OTHER,
      },
    ]);

    expect(response.statusCode).toBe(200);
    const data = response.json().data as Array<{ id: string; outcomeId?: string | null }>;
    expect(data).toHaveLength(1);
    expect(data[0]?.id).toBe('aa914143-89ef-4a31-922e-ac753aa6f41e');
    expect(data[0]?.outcomeId).toBe(OUTCOME_ID);
  });

  it('keeps outcomeId null (not undefined) when the material row has no outcome', async () => {
    const response = await getMaterials([
      {
        id: 'cc914143-89ef-4a31-922e-ac753aa6f41e',
        label: 'Materi tanpa CP',
        outcomeId: null,
        publishedVersion: 1,
        tenantId: TENANT,
      },
    ]);

    const data = response.json().data as Array<{ outcomeId?: string | null }>;
    expect(data).toHaveLength(1);
    expect(data[0]?.outcomeId).toBeNull();
  });

  it('exposes the derived <subjectId>-cp outcome on the official catalog branch', async () => {
    const app = Fastify();
    await registerCatalogRoutes(app, { jwtSecret: SECRET });

    const grades = await app.inject({ method: 'GET', url: '/v1/catalog/grades' });
    const grade = grades.json().data.find((item: { id: string }) =>
      item.id.startsWith('official-grade-sd-mi-'),
    );
    const subjects = await app.inject({
      method: 'GET',
      url: `/v1/catalog/subjects?gradeId=${encodeURIComponent(grade.id)}`,
    });

    // Pick a subject that actually carries a CP, so both material kinds are covered.
    let subjectId = '';
    let data: Array<{ id: string; kind?: string; outcomeId?: string | null }> = [];
    for (const candidate of subjects.json().data as Array<{ id: string }>) {
      const probe = await app.inject({
        method: 'GET',
        url: `/v1/catalog/materials?gradeId=${encodeURIComponent(grade.id)}&subjectId=${encodeURIComponent(candidate.id)}&curriculumVersionId=11111111-1111-1111-1111-111111111111`,
      });
      const rows = probe.json().data as typeof data;
      if (rows.some((item) => item.kind === 'learning_outcome') && rows.length > 1) {
        subjectId = candidate.id;
        data = rows;
        break;
      }
    }
    await app.close();

    expect(subjectId, 'no official subject with a CP found').not.toBe('');
    expect(data.length).toBeGreaterThan(0);
    // Every official material — CP itself and each topic — names the same CP.
    expect(data.every((item) => item.outcomeId === `${subjectId}-cp`)).toBe(true);
    expect(
      data.some((item) => item.kind === 'learning_outcome' && item.outcomeId === item.id),
    ).toBe(true);
    expect(
      data.some((item) => item.kind === 'topic' && item.outcomeId === `${subjectId}-cp`),
    ).toBe(true);
  });

  it('does not leak outcomeId from another tenant', async () => {
    const response = await getMaterials([
      {
        id: 'dd914143-89ef-4a31-922e-ac753aa6f41e',
        label: 'Gate material',
        outcomeId: 'ffffffff-1111-2222-3333-444444444444',
        publishedVersion: 1,
        tenantId: OTHER,
      },
    ]);

    // No own rows → falls back to the official catalog, never the other tenant.
    const data = response.json().data as Array<{ id: string }>;
    expect(data.every((item) => item.id !== 'dd914143-89ef-4a31-922e-ac753aa6f41e')).toBe(true);
  });
});
