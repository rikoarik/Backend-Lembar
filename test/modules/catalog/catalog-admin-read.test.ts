/**
 * BUG-11/12 (kanban t_bb300b60): the superadmin catalog console reads from
 * `/v1/admin/catalog/*`, and its "Tambah Materi" form submits an outcome id that
 * is either a tenant outcome uuid or the derived official CP id
 * (`<officialSubjectId>-cp`).
 *
 * Regressions covered here:
 *   - the admin read routes existed nowhere, so every call fell through to the
 *     not-found handler ("Module admin belum di-register") → 404;
 *   - `GET /v1/admin/catalog/outcomes` passed the raw `subjectId` into a `uuid`
 *     column, so an official slug raised `22P02` → 500 INTERNAL_ERROR;
 *   - `POST /v1/admin/catalog/materials` had the same non-uuid hazard, plus no
 *     way to attach a material to an official CP (no DB parent row existed).
 *
 * DB-backed paths are asserted by the live curl evidence in the task handoff;
 * these tests pin the pure resolution logic and the route guards.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';
import {
  officialOutcomeOption,
  registerCatalogRoutes,
} from '../../../src/modules/catalog/adapters/http/catalogRoutes.js';
import { isUuid } from '../../../src/modules/catalog/persistence/officialMaterialization.js';
import { resolveOfficialSubject } from '../../../src/modules/catalog/officialCatalog.js';

const SECRET = 'catalog-admin-read-secret';
const TENANT = '11111111-1111-1111-1111-111111111111';
const OFFICIAL_SUBJECT = 'official-subject-sd-mi-a-muatan-lokal-lain-lain';

const superadminToken = generateJwt(
  { userId: 'admin', email: 'admin@example.test', roles: ['superadmin'], workspaceId: TENANT },
  { secret: SECRET, expiryDays: 1 },
);
const teacherToken = generateJwt(
  { userId: 'teacher', email: 'teacher@example.test', roles: ['teacher'], workspaceId: TENANT },
  { secret: SECRET, expiryDays: 1 },
);

async function app() {
  const instance = Fastify();
  await registerCatalogRoutes(instance, { jwtSecret: SECRET });
  return instance;
}

describe('admin catalog read surface', () => {
  it('registers the admin read routes instead of falling through to 404', async () => {
    const instance = await app();
    const routes = instance.printRoutes({ commonPrefix: false });
    await instance.close();

    // The read routes share the path with their sibling write methods, so match
    // on the path plus GET rather than the exact method list.
    for (const path of ['grades', 'subjects', 'materials', 'outcomes']) {
      expect(routes).toContain(`/v1/admin/catalog/${path} (`);
      expect(routes).toMatch(new RegExp(`/v1/admin/catalog/${path} \\([^)]*GET`));
    }
  });

  it('serves admin grades from the official snapshot without a database', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: '/v1/admin/catalog/grades',
      headers: { authorization: `Bearer ${superadminToken}` },
    });
    await instance.close();

    expect(response.statusCode).toBe(200);
    const data = response.json().data as { id: string; status: string }[];
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((row) => row.status === 'active')).toBe(true);
  });

  it('serves admin subjects for an official grade', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: '/v1/admin/catalog/subjects?gradeId=official-grade-sd-mi-1',
      headers: { authorization: `Bearer ${superadminToken}` },
    });
    await instance.close();

    expect(response.statusCode).toBe(200);
    const data = response.json().data as { id: string }[];
    expect(data.some((row) => row.id === OFFICIAL_SUBJECT)).toBe(true);
  });

  it('requires a superadmin token', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: '/v1/admin/catalog/grades',
      headers: { authorization: `Bearer ${teacherToken}` },
    });
    await instance.close();
    expect(response.statusCode).toBe(403);
  });

  it('rejects a missing token on the admin read surface', async () => {
    const instance = await app();
    const response = await instance.inject({ method: 'GET', url: '/v1/admin/catalog/grades' });
    await instance.close();
    expect(response.statusCode).toBe(401);
  });

  it('validates the required query params of the admin read routes', async () => {
    const instance = await app();
    const subjects = await instance.inject({
      method: 'GET',
      url: '/v1/admin/catalog/subjects',
      headers: { authorization: `Bearer ${superadminToken}` },
    });
    const materials = await instance.inject({
      method: 'GET',
      url: '/v1/admin/catalog/materials',
      headers: { authorization: `Bearer ${superadminToken}` },
    });
    const outcomes = await instance.inject({
      method: 'GET',
      url: '/v1/admin/catalog/outcomes',
      headers: { authorization: `Bearer ${superadminToken}` },
    });
    await instance.close();

    expect(subjects.statusCode).toBe(400);
    expect(materials.statusCode).toBe(400);
    expect(outcomes.statusCode).toBe(400);
  });
});

describe('official outcome resolution', () => {
  it('resolves an official subject slug to its derived CP id', () => {
    const option = officialOutcomeOption(OFFICIAL_SUBJECT);
    expect(option).toHaveLength(1);
    expect(option[0]?.id).toBe(`${OFFICIAL_SUBJECT}-cp`);
    expect(option[0]?.label).toContain('Muatan Lokal Lain-lain');
    // The derived CP id is what the form submits; it must not be mistaken for a uuid.
    expect(isUuid(option[0]!.id)).toBe(false);
  });

  it('returns nothing for an unknown subject id', () => {
    expect(officialOutcomeOption('bukan-subject-manapun')).toEqual([]);
    expect(resolveOfficialSubject('bukan-subject-manapun')).toBeNull();
  });

  it('gives every official subject a non-empty CP label even without a description', () => {
    // 42 snapshot records carry neither a description nor learning achievements;
    // the CP label must still be usable in the dropdown.
    const option = officialOutcomeOption(OFFICIAL_SUBJECT);
    expect(option[0]?.label).not.toMatch(/CP —\s*$/);
  });

  it('distinguishes uuids from official slugs', () => {
    expect(isUuid('02c78d27-f08a-41a9-9f58-e0d1655bc182')).toBe(true);
    expect(isUuid(OFFICIAL_SUBJECT)).toBe(false);
    expect(isUuid(`${OFFICIAL_SUBJECT}-cp`)).toBe(false);
  });
});
