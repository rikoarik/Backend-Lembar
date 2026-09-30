import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/bootstrap/app.js';
import {
  closeDatabase,
  createDatabase,
  type Database,
} from '../../../src/infrastructure/database/db.js';
import {
  marketingContent,
  marketingContentVersions,
} from '../../../src/infrastructure/database/schema.js';
import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const hasDb = DATABASE_URL.length > 0;

// Must match app.ts default: process.env.JWT_SECRET || 'dev-secret-change-in-production'
const JWT_SECRET = process.env['JWT_SECRET'] ?? 'dev-secret-change-in-production';
const SUPERADMIN_ID = '00000000-0000-0000-0000-000000000001';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..', '..');
const seedMigration = path.join(
  projectRoot,
  'src',
  'infrastructure',
  'database',
  'migrations',
  '0043_marketing_page_seed.sql',
);

function makeAuth(): Record<string, string> {
  return {
    authorization: `Bearer ${generateJwt(
      {
        userId: SUPERADMIN_ID,
        email: 'superadmin@lembar.test',
        roles: ['superadmin'],
        workspaceId: null,
      },
      { secret: JWT_SECRET, expiryDays: 1 },
    )}`,
  };
}

const PUBLIC_PAGE_SLUGS = ['home', 'harga', 'untuk-sekolah'] as const;

// FE-VER-02 F-2: live /ops/content showed empty panels because marketing_content
// only ever held the __global__ row — the three public pages were never seeded,
// so GET /v1/ops/marketing/pages returned [] and every per-slug read was a 404.
describe.skipIf(!hasDb)('marketing page seed migration (0043)', () => {
  let db: Database;
  let seedSql: string;

  beforeAll(async () => {
    db = createDatabase({ connectionString: DATABASE_URL });
    seedSql = await readFile(seedMigration, 'utf8');
  });

  beforeEach(async () => {
    await db.delete(marketingContentVersions);
    await db.delete(marketingContent);
  });

  afterAll(async () => {
    if (db) await closeDatabase(db);
  });

  it('is a no-op when the pages already exist (never clobbers edits)', async () => {
    await db.execute(seedSql);
    await db.execute(seedSql);

    const rows = await db.select().from(marketingContent).execute();
    expect(rows).toHaveLength(PUBLIC_PAGE_SLUGS.length);
    expect(rows.map((row) => row.slug).sort()).toEqual([...PUBLIC_PAGE_SLUGS].sort());
    expect(rows.every((row) => row.kind === 'page')).toBe(true);

    // A second application must not duplicate or re-draft an edited page.
    await db.execute(seedSql);
    const after = await db.select().from(marketingContent).execute();
    expect(after).toHaveLength(PUBLIC_PAGE_SLUGS.length);
    expect(after.every((row) => row.revision === 1)).toBe(true);
  });

  it('makes GET /v1/ops/marketing/pages list all three public pages', async () => {
    await db.execute(seedSql);

    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/ops/marketing/pages',
        headers: makeAuth(),
      });
      expect(response.statusCode).toBe(200);
      const slugs = response.json().data.map((page: { slug: string }) => page.slug).sort();
      expect(slugs).toEqual([...PUBLIC_PAGE_SLUGS].sort());
    } finally {
      await app.close();
    }
  });

  it('returns 200 with a usable draft for each seeded slug', async () => {
    await db.execute(seedSql);

    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      for (const slug of PUBLIC_PAGE_SLUGS) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/ops/marketing/pages/${slug}`,
          headers: makeAuth(),
        });
        expect(response.statusCode, `GET /v1/ops/marketing/pages/${slug}`).toBe(200);

        const body = response.json();
        expect(body.data.summary.slug).toBe(slug);
        expect(body.data.summary.state).toBe('draft');
        expect(body.data.summary.revision).toBe(1);
        // The console's JSON editor needs a schema-shaped draft to open on.
        expect(body.data.draft.schemaVersion).toBe(1);
        expect(body.data.draft.blocks.length).toBeGreaterThan(0);
        expect(typeof body.data.draft.seo.title).toBe('string');
        // Not published yet: the public marketing pages keep their JSX fallback.
        expect(body.data.summary.publishedVersion).toBeNull();
      }
    } finally {
      await app.close();
    }
  });

  it('leaves the public read routes untouched until a superadmin publishes', async () => {
    await db.execute(seedSql);

    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      for (const slug of PUBLIC_PAGE_SLUGS) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/public/marketing/pages/${slug}`,
        });
        expect(response.statusCode, `public ${slug}`).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it('keeps a seeded draft readable through the ops route after an edit', async () => {
    await db.execute(seedSql);

    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      const saved = await app.inject({
        method: 'PUT',
        url: '/v1/ops/marketing/pages/home/draft',
        headers: { ...makeAuth(), 'if-match': '1' },
        payload: {
          schemaVersion: 1,
          blocks: [{ id: 'hero-1', type: 'hero', heading: 'Diedit' }],
          seo: { title: 'Home', description: 'Diedit oleh ops' },
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().data.summary.revision).toBe(2);

      // Re-applying the migration must not reset the edited revision.
      await db.execute(seedSql);
      const reread = await app.inject({
        method: 'GET',
        url: '/v1/ops/marketing/pages/home',
        headers: makeAuth(),
      });
      expect(reread.statusCode).toBe(200);
      expect(reread.json().data.summary.revision).toBe(2);
    } finally {
      await app.close();
    }
  });
});
