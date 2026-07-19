import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
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
import { etagForPayload } from '../../../src/modules/marketing/domain/MarketingRepository.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const hasDb = DATABASE_URL.length > 0;
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..', '..');
const migrationsFolder = path.join(projectRoot, 'src', 'infrastructure', 'database', 'migrations');

describe.skipIf(!hasDb)('marketing published read routes', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase({ connectionString: DATABASE_URL });
    await migrate(db, { migrationsFolder });
  });

  beforeEach(async () => {
    await db.delete(marketingContentVersions);
    await db.delete(marketingContent);
  });

  afterAll(async () => {
    if (db) await closeDatabase(db);
  });

  it('reads only published global content with ETag and 304 support', async () => {
    const payload = {
      navigation: [{ id: 'nav-home', title: 'Beranda' }],
      footer: [{ id: 'footer-email', title: 'Halo' }],
      ctas: [
        {
          id: 'cta-main',
          label: 'Mulai',
          href: '/mulai',
          variant: 'primary',
          placement: 'hero',
          audience: 'all',
          trackingKey: 'hero_mulai',
          enabled: true,
        },
      ],
    };
    const [content] = await db
      .insert(marketingContent)
      .values({
        kind: 'global',
        slug: '__global__',
        locale: 'id-ID',
        currentVersion: 2,
        publishedVersion: 1,
        draftPayload: {
          navigation: [{ id: 'draft-only', title: 'Rahasia' }],
          footer: [],
          ctas: [],
        },
      })
      .returning();
    await db.insert(marketingContentVersions).values({
      contentId: content!.id,
      version: 1,
      payload,
    });

    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/public/marketing/global' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe(
        'public, max-age=60, stale-while-revalidate=300',
      );
      expect(response.json()).toEqual({
        data: {
          locale: 'id-ID',
          version: 1,
          navigation: payload.navigation,
          footer: payload.footer,
          ctas: payload.ctas,
        },
      });
      const etag = response.headers.etag;
      expect(etag).toBe(
        etagForPayload({
          locale: 'id-ID',
          version: 1,
          navigation: payload.navigation,
          footer: payload.footer,
          ctas: payload.ctas,
        }),
      );
      const notModified = await app.inject({
        method: 'GET',
        url: '/v1/public/marketing/global',
        headers: { 'if-none-match': String(etag) },
      });
      expect(notModified.statusCode).toBe(304);
      expect(notModified.body).toBe('');
    } finally {
      await app.close();
    }
  });

  it('does not disclose draft-only or unpublished pages', async () => {
    const [published] = await db
      .insert(marketingContent)
      .values({
        kind: 'page',
        slug: 'home',
        locale: 'id-ID',
        currentVersion: 3,
        publishedVersion: 1,
        draftPayload: {
          schemaVersion: 1,
          blocks: [{ id: 'draft', type: 'hero', heading: 'Draft only' }],
          seo: { title: 'Draft', description: 'Draft' },
        },
      })
      .returning();
    await db.insert(marketingContentVersions).values({
      contentId: published!.id,
      version: 1,
      payload: {
        schemaVersion: 1,
        blocks: [{ id: 'hero', type: 'hero', heading: 'Terbit' }],
        seo: { title: 'Home', description: 'Terbit' },
      },
    });
    await db.insert(marketingContent).values({
      kind: 'page',
      slug: 'harga',
      locale: 'id-ID',
      currentVersion: 1,
      publishedVersion: null,
      draftPayload: {
        schemaVersion: 1,
        blocks: [{ id: 'pricing-draft', type: 'pricing', heading: 'Belum terbit' }],
        seo: { title: 'Harga', description: 'Draft' },
      },
    });

    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      const publishedResponse = await app.inject({
        method: 'GET',
        url: '/v1/public/marketing/pages/home',
      });
      expect(publishedResponse.statusCode).toBe(200);
      const body = publishedResponse.json();
      expect(body.data.blocks[0].heading).toBe('Terbit');
      expect(JSON.stringify(body)).not.toContain('Draft only');

      const missing = await app.inject({ method: 'GET', url: '/v1/public/marketing/pages/harga' });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('rejects unsupported locale and invalid published payloads', async () => {
    const [content] = await db
      .insert(marketingContent)
      .values({
        kind: 'page',
        slug: 'untuk-sekolah',
        locale: 'id-ID',
        currentVersion: 1,
        publishedVersion: 1,
      })
      .returning();
    await db.insert(marketingContentVersions).values({
      contentId: content!.id,
      version: 1,
      payload: { blocks: [], seo: { title: 'Broken' } },
    });

    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      const invalidLocale = await app.inject({
        method: 'GET',
        url: '/v1/public/marketing/global?locale=en-US',
      });
      expect(invalidLocale.statusCode).toBe(400);
      expect(invalidLocale.json().error.code).toBe('VALIDATION_FAILED');

      const invalidPayload = await app.inject({
        method: 'GET',
        url: '/v1/public/marketing/pages/untuk-sekolah',
      });
      expect(invalidPayload.statusCode).toBe(400);
      expect(invalidPayload.json().error.code).toBe('VALIDATION_FAILED');
    } finally {
      await app.close();
    }
  });

  it('rejects invalid nested CTA hrefs and unknown block fields', async () => {
    const [content] = await db
      .insert(marketingContent)
      .values({
        kind: 'page',
        slug: 'untuk-sekolah',
        locale: 'id-ID',
        currentVersion: 1,
        publishedVersion: 1,
      })
      .returning();
    await db.insert(marketingContentVersions).values({
      contentId: content!.id,
      version: 1,
      payload: {
        schemaVersion: 1,
        blocks: [
          {
            id: 'hero-1',
            type: 'hero',
            heading: 'Valid heading',
            extra: 'should fail',
            ctas: [
              {
                id: 'cta-1',
                label: 'Klik',
                href: 'javascript:alert(1)',
                variant: 'primary',
                placement: 'hero',
                audience: 'all',
                trackingKey: 'hero_click',
                enabled: true,
              },
            ],
          },
        ],
        seo: { title: 'Valid title', description: 'Valid description' },
      },
    });

    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/public/marketing/pages/untuk-sekolah',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_FAILED');
    } finally {
      await app.close();
    }
  });

  it('rejects invalid global CTA arrays and oversized nested strings', async () => {
    const [content] = await db
      .insert(marketingContent)
      .values({
        kind: 'global',
        slug: '__global__',
        locale: 'id-ID',
        currentVersion: 1,
        publishedVersion: 1,
      })
      .returning();
    await db.insert(marketingContentVersions).values({
      contentId: content!.id,
      version: 1,
      payload: {
        navigation: [
          {
            id: 'nav-1',
            title: 'X'.repeat(201),
          },
        ],
        footer: [],
        ctas: [
          {
            id: 'cta-a',
            label: 'A',
            href: '/a',
            variant: 'primary',
            placement: 'nav',
            audience: 'all',
            trackingKey: 'a',
            enabled: true,
          },
          {
            id: 'cta-b',
            label: 'B',
            href: '/b',
            variant: 'primary',
            placement: 'nav',
            audience: 'all',
            trackingKey: 'b',
            enabled: true,
          },
          {
            id: 'cta-c',
            label: 'C',
            href: '/c',
            variant: 'primary',
            placement: 'nav',
            audience: 'all',
            trackingKey: 'c',
            enabled: true,
          },
          {
            id: 'cta-d',
            label: 'D',
            href: '/d',
            variant: 'primary',
            placement: 'nav',
            audience: 'all',
            trackingKey: 'd',
            enabled: true,
          },
          {
            id: 'cta-e',
            label: 'E',
            href: '/e',
            variant: 'primary',
            placement: 'nav',
            audience: 'all',
            trackingKey: 'e',
            enabled: true,
          },
        ],
      },
    });

    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/public/marketing/global' });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_FAILED');
    } finally {
      await app.close();
    }
  });
});
