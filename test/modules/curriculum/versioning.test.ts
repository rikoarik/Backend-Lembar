import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/bootstrap/app.js';
import {
  closeDatabase,
  createDatabase,
  type Database,
} from '../../../src/infrastructure/database/db.js';
import { tenants } from '../../../src/infrastructure/database/schema.js';
import {
  CurriculumRepository,
  etagForPayload,
} from '../../../src/modules/curriculum/domain/CurriculumRepository.js';
import { VersioningService } from '../../../src/modules/curriculum/domain/VersioningService.js';

const STUB_BEARER = 'vitest-stub-bearer';
const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const hasDb = DATABASE_URL.length > 0;
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..', '..');
const migrationsFolder = path.join(projectRoot, 'src', 'infrastructure', 'database', 'migrations');

describe.skipIf(!hasDb)('curriculum versioning', () => {
  let db: Database;
  let repo: CurriculumRepository;
  let service: VersioningService;

  beforeAll(async () => {
    db = createDatabase({ connectionString: DATABASE_URL });
    await migrate(db, { migrationsFolder });
    repo = new CurriculumRepository(db);
    service = new VersioningService(repo);
  });

  afterAll(async () => {
    if (db) await closeDatabase(db);
  });

  it('1. draft write does NOT mutate published version', async () => {
    const tenant = await makeTenant(db, 'draft-stable');
    const draft = await service.createDraft(
      'curricula',
      {
        tenantId: tenant.id,
        slug: `curr-${Date.now()}`,
        code: `K-${Date.now()}`,
        title: 'Kurikulum awal',
        level: 'sma',
      },
      'req-test-1',
    );
    const id = String(draft.data['id']);
    await service.publish('curricula', id, 'req-test-1b', STUB_BEARER);
    const publishedBefore = await repo.getHead('curricula', id);

    await service.updateDraft(
      'curricula',
      id,
      { title: 'Kurikulum revisi (draft)' },
      'req-test-1c',
    );

    const publishedAfter = await repo.getHead('curricula', id);
    expect(publishedAfter?.publishedVersion).toBe(publishedBefore?.publishedVersion);
  });

  it('2. publish is atomic (no half-version)', async () => {
    const tenant = await makeTenant(db, 'atomic');
    const draft = await service.createDraft(
      'curricula',
      {
        tenantId: tenant.id,
        slug: `curr-atomic-${Date.now()}`,
        code: `K-AT-${Date.now()}`,
        title: 'Atomic',
        level: 'smp',
      },
      'req-test-2',
    );
    const id = String(draft.data['id']);
    const published = await service.publish('curricula', id, 'req-test-2b', STUB_BEARER);
    const version = Number(published.data['version']);
    const head = await repo.getHead('curricula', id);
    const row = await repo.getVersion('curricula', id, version);
    expect(head?.publishedVersion).toBe(version);
    expect(row?.version).toBe(version);
  });

  it('3. concurrent publishes serialize via unique key', async () => {
    const tenant = await makeTenant(db, 'concurrent');
    const draft = await service.createDraft(
      'curricula',
      {
        tenantId: tenant.id,
        slug: `curr-concurrent-${Date.now()}`,
        code: `K-CC-${Date.now()}`,
        title: 'Concurrent',
        level: 'sma',
      },
      'req-test-3',
    );
    const id = String(draft.data['id']);
    const results = await Promise.allSettled([
      service.publish('curricula', id, 'req-test-3a', STUB_BEARER),
      service.publish('curricula', id, 'req-test-3b', STUB_BEARER),
    ]);
    const versions = await repo.listVersions('curricula', id, 100);
    const successful = results.filter((entry) => entry.status === 'fulfilled');
    expect(successful.length).toBeGreaterThanOrEqual(1);
    expect(versions.length).toBe(successful.length);
    expect(new Set(versions.map((entry) => entry.version)).size).toBe(versions.length);
  });

  it('4. source_rights_gate blocks invalid licenses', async () => {
    const ids = await makePublishedChain(service, db, 'gate');
    const badMaterial = await service.createDraft(
      'materials',
      {
        outcomeId: ids.outcomeId,
        code: `M-BAD-${Date.now()}`,
        kind: 'reading',
        title: 'Unknown source',
        sourceRights: 'license:unknown',
      },
      'req-test-4',
    );
    const badId = String(badMaterial.data['id']);
    await expect(
      service.publish('materials', badId, 'req-test-4b', STUB_BEARER),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('5. published projection filters draft versions', async () => {
    const tenant = await makeTenant(db, 'projection');
    const draft = await service.createDraft(
      'curricula',
      {
        tenantId: tenant.id,
        slug: `curr-projection-${Date.now()}`,
        code: `K-PRJ-${Date.now()}`,
        title: 'Projection v1',
        level: 'sma',
      },
      'req-test-5',
    );
    const id = String(draft.data['id']);
    await service.publish('curricula', id, 'req-test-5a', STUB_BEARER);
    await service.updateDraft('curricula', id, { title: 'Projection draft only' }, 'req-test-5b');

    const projection = await repo.readPublishedCatalogByTenantSlug(tenant.slug);
    expect(projection?.curriculum['title']).toBe('Projection v1');
    expect(projection?.curriculum['title']).not.toBe('Projection draft only');
  });

  it('6. ETag computes deterministically from version payload bytes', async () => {
    const a = etagForPayload({ id: '1', title: 'Stable', ordering: 0 });
    const b = etagForPayload({ ordering: 0, title: 'Stable', id: '1' });
    const c = etagForPayload({ ordering: 0, title: 'Changed', id: '1' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('7. list endpoint returns paginated history, 100-cap honored', async () => {
    const tenant = await makeTenant(db, 'history');
    const draft = await service.createDraft(
      'curricula',
      {
        tenantId: tenant.id,
        slug: `curr-history-${Date.now()}`,
        code: `K-HST-${Date.now()}`,
        title: 'History',
        level: 'sma',
      },
      'req-test-7',
    );
    const id = String(draft.data['id']);
    for (let i = 0; i < 3; i++) {
      await service.publish('curricula', id, `req-test-7-${i}`, STUB_BEARER);
    }
    const small = await service.listVersions('curricula', id, 2, 'req-test-7a');
    const capped = await service.listVersions('curricula', id, 250, 'req-test-7b');
    expect(small.data.length).toBe(2);
    expect(small.page.hasMore).toBe(true);
    expect(capped.page.limit).toBe(100);
  });

  it("8. cross-tenant query isolation: tenant A never returns tenant B's data", async () => {
    const tenantA = await makeTenant(db, 'tenant-a');
    const tenantB = await makeTenant(db, 'tenant-b');
    const draftA = await service.createDraft(
      'curricula',
      {
        tenantId: tenantA.id,
        slug: `curr-tenant-a-${Date.now()}`,
        code: `K-TA-${Date.now()}`,
        title: 'Tenant A only',
        level: 'sma',
      },
      'req-test-8',
    );
    const draftB = await service.createDraft(
      'curricula',
      {
        tenantId: tenantB.id,
        slug: `curr-tenant-b-${Date.now()}`,
        code: `K-TB-${Date.now()}`,
        title: 'Tenant B only',
        level: 'sma',
      },
      'req-test-8b',
    );
    await service.publish('curricula', String(draftA.data['id']), 'req-test-8c', STUB_BEARER);
    await service.publish('curricula', String(draftB.data['id']), 'req-test-8d', STUB_BEARER);

    const projectionA = await repo.readPublishedCatalogByTenantSlug(tenantA.slug);
    const projectionB = await repo.readPublishedCatalogByTenantSlug(tenantB.slug);
    expect(projectionA?.curriculum['id']).toBe(draftA.data['id']);
    expect(projectionA?.curriculum['id']).not.toBe(draftB.data['id']);
    expect(projectionB?.curriculum['id']).toBe(draftB.data['id']);
  });

  it('route layer enforces stub bearer for writes', async () => {
    const tenant = await makeTenant(db, 'http');
    const app = await buildApp({ logger: false, curriculumDb: db });
    await app.ready();
    try {
      const denied = await app.inject({
        method: 'POST',
        url: '/v1/curriculum/curricula',
        payload: {
          tenantId: tenant.id,
          slug: `curr-http-${Date.now()}`,
          code: `K-HTTP-${Date.now()}`,
          title: 'No bearer',
          level: 'sma',
        },
      });
      expect(denied.statusCode).toBe(401);

      const allowed = await app.inject({
        method: 'POST',
        url: '/v1/curriculum/curricula',
        headers: { authorization: `Bearer ${STUB_BEARER}` },
        payload: {
          tenantId: tenant.id,
          slug: `curr-http-ok-${Date.now()}`,
          code: `K-HTTP-OK-${Date.now()}`,
          title: 'With bearer',
          level: 'sma',
        },
      });
      expect(allowed.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });
});

async function makeTenant(db: Database, name: string): Promise<{ id: string; slug: string }> {
  const slug = `${name}-${Date.now()}`;
  const [row] = await db.insert(tenants).values({ slug, name }).returning();
  if (!row) throw new Error('tenant insert returned no row');
  return { id: row.id, slug: row.slug };
}

async function makePublishedChain(
  service: VersioningService,
  db: Database,
  name: string,
): Promise<{ outcomeId: string }> {
  const tenant = await makeTenant(db, name);
  const curriculum = await service.createDraft(
    'curricula',
    {
      tenantId: tenant.id,
      slug: `curr-${name}-${Date.now()}`,
      code: `K-${name}-${Date.now()}`,
      title: name,
      level: 'sma',
    },
    `req-${name}-1`,
  );
  const curriculumId = String(curriculum.data['id']);
  await service.publish('curricula', curriculumId, `req-${name}-2`, STUB_BEARER);

  const grade = await service.createDraft(
    'grades',
    { curriculumId, code: `G-${name}-${Date.now()}`, label: `${name} grade` },
    `req-${name}-3`,
  );
  const gradeId = String(grade.data['id']);
  await service.publish('grades', gradeId, `req-${name}-4`, STUB_BEARER);

  const phase = await service.createDraft(
    'phases',
    { gradeId, code: `P-${name}-${Date.now()}`, label: `${name} phase` },
    `req-${name}-5`,
  );
  const phaseId = String(phase.data['id']);
  await service.publish('phases', phaseId, `req-${name}-6`, STUB_BEARER);

  const subject = await service.createDraft(
    'subjects',
    { phaseId, code: `S-${name}-${Date.now()}`, title: `${name} subject` },
    `req-${name}-7`,
  );
  const subjectId = String(subject.data['id']);
  await service.publish('subjects', subjectId, `req-${name}-8`, STUB_BEARER);

  const outcome = await service.createDraft(
    'outcomes',
    {
      subjectId,
      code: `O-${name}-${Date.now()}`,
      text: `${name} outcome`,
      bloomLevel: 'apply',
    },
    `req-${name}-9`,
  );
  const outcomeId = String(outcome.data['id']);
  await service.publish('outcomes', outcomeId, `req-${name}-10`, STUB_BEARER);
  return { outcomeId };
}
