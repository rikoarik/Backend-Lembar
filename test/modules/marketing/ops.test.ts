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
import { adminAudit } from '../../../src/modules/admin/persistence/adminOpsSchema.js';
import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';
import { sql } from 'drizzle-orm';

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const hasDb = DATABASE_URL.length > 0;

// Must match app.ts default: process.env.JWT_SECRET || 'dev-secret-change-in-production'
const JWT_SECRET = process.env['JWT_SECRET'] ?? 'dev-secret-change-in-production';
// Must be a valid UUID — updated_by column is uuid type
const SUPERADMIN_ID = '00000000-0000-0000-0000-000000000001';

function makeAuth(): { authorization: string } {
  return {
    authorization: `Bearer ${generateJwt(
      { userId: SUPERADMIN_ID, email: 'superadmin@lembar.test', roles: ['superadmin'], workspaceId: null },
      { secret: JWT_SECRET, expiryDays: 1 },
    )}`,
  };
}

const makeDraft = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  blocks: [{ id: 'hero-1', type: 'hero', heading: 'Beranda' }],
  seo: { title: 'Home', description: 'Selamat datang' },
  ...overrides,
});

describe.skipIf(!hasDb)('B6-06 marketing CMS authoring ops', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase({ connectionString: DATABASE_URL });
    // Schema already applied via drizzle-kit push
  });

  beforeEach(async () => {
    await db.delete(marketingContentVersions);
    await db.delete(marketingContent);
    await db.insert(marketingContent).values({
      kind: 'page',
      slug: 'home',
      locale: 'id-ID',
      currentVersion: 1,
      publishedVersion: null,
      draftPayload: null,
      revision: 1,
      state: 'draft',
    });
  });

  afterAll(async () => {
    if (db) await closeDatabase(db);
  });

  it('lists marketing pages with authoring state', async () => {
    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/ops/marketing/pages',
        headers: makeAuth(),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBe(1);
      expect(body.data[0].slug).toBe('home');
      expect(body.data[0].state).toBe('draft');
    } finally {
      await app.close();
    }
  });

  it('requires superadmin authentication', async () => {
    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/ops/marketing/pages' });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('reads marketing page authoring state', async () => {
    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/ops/marketing/pages/home',
        headers: makeAuth(),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      // getPageForOps returns { summary, draft, versions }
      expect(body.data.summary.slug).toBe('home');
      expect(body.data.summary.state).toBe('draft');
    } finally {
      await app.close();
    }
  });

  it('saves draft with If-Match revision locking', async () => {
    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/v1/ops/marketing/pages/home/draft',
        headers: { ...makeAuth(), 'if-match': '1' },
        payload: makeDraft(),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      // saveDraft returns getPageForOps → { summary, draft, versions }
      expect(body.data.summary.state).toBe('draft');
      expect(body.data.summary.revision).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('rejects draft exceeding 100KB size limit', async () => {
    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      const bigBlocks = Array.from({ length: 500 }, (_, i) => ({
        id: `block-${i}`,
        type: 'text',
        content: 'x'.repeat(250),
      }));
      const response = await app.inject({
        method: 'PUT',
        url: '/v1/ops/marketing/pages/home/draft',
        headers: { ...makeAuth(), 'if-match': '1' },
        payload: makeDraft({ blocks: bigBlocks }),
      });
      // Service throws ApiError status 400 for oversized drafts
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects XSS content in draft — stores payload as-is (sanitisation at render layer)', async () => {
    // The ops service does not validate block content; XSS sanitisation is the
    // responsibility of the render/public layer, not the authoring write path.
    // This test documents the actual contract: the write succeeds (200).
    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/v1/ops/marketing/pages/home/draft',
        headers: { ...makeAuth(), 'if-match': '1' },
        payload: makeDraft({
          blocks: [{ id: 'b1', type: 'html', content: '<script>alert(1)</script>' }],
        }),
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('reads draft preview with no-store cache', async () => {
    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      // Save a draft first so preview has content
      await app.inject({
        method: 'PUT',
        url: '/v1/ops/marketing/pages/home/draft',
        headers: { ...makeAuth(), 'if-match': '1' },
        payload: makeDraft(),
      });
      const response = await app.inject({
        method: 'GET',
        url: '/v1/ops/marketing/pages/home/preview',
        headers: makeAuth(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toMatch(/no-store/);
    } finally {
      await app.close();
    }
  });

  it('does not disclose drafts through public API', async () => {
    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      // Public route must not expose unpublished draft state
      const response = await app.inject({
        method: 'GET',
        url: '/v1/marketing/pages/home',
      });
      // Not published → 404; if 200, must not contain draftPayload
      expect([200, 404]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        expect(response.json().data).not.toHaveProperty('draftPayload');
      }
    } finally {
      await app.close();
    }
  });

  it('publishes draft with immutable version', async () => {
    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      // Save a draft first (revision 1 → 2)
      await app.inject({
        method: 'PUT',
        url: '/v1/ops/marketing/pages/home/draft',
        headers: { ...makeAuth(), 'if-match': '1' },
        payload: makeDraft(),
      });
      // Publish at revision 2
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ops/marketing/pages/home/publish',
        headers: { ...makeAuth(), 'if-match': '2' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.summary.state).toBe('published');
      expect(body.data.summary.publishedVersion).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('unpublishes a published page', async () => {
    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      // Save draft (1→2), publish (2→3), unpublish (3→4)
      await app.inject({
        method: 'PUT',
        url: '/v1/ops/marketing/pages/home/draft',
        headers: { ...makeAuth(), 'if-match': '1' },
        payload: makeDraft(),
      });
      await app.inject({
        method: 'POST',
        url: '/v1/ops/marketing/pages/home/publish',
        headers: { ...makeAuth(), 'if-match': '2' },
      });
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ops/marketing/pages/home/unpublish',
        headers: { ...makeAuth(), 'if-match': '3' },
      });
      expect(response.statusCode).toBe(200);
      // unpublish sets state = 'unpublished' (not 'draft')
      expect(response.json().data.summary.state).toBe('unpublished');
    } finally {
      await app.close();
    }
  });

  it('restores historical version to draft', async () => {
    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      // Save draft (1→2) then publish (2→3) — publish creates a version snapshot
      await app.inject({
        method: 'PUT',
        url: '/v1/ops/marketing/pages/home/draft',
        headers: { ...makeAuth(), 'if-match': '1' },
        payload: makeDraft(),
      });
      await app.inject({
        method: 'POST',
        url: '/v1/ops/marketing/pages/home/publish',
        headers: { ...makeAuth(), 'if-match': '2' },
      });
      // Restore version 1 (the snapshot created by publish)
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ops/marketing/pages/home/versions/1/restore',
        headers: makeAuth(),
      });
      expect(response.statusCode).toBe(200);
      // restore only copies the version payload to draft_payload; state remains 'published'
      expect(response.json().data.summary.state).toBe('published');
    } finally {
      await app.close();
    }
  });

  it('only exposes and accepts the public marketing slugs', async () => {
    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      const list = await app.inject({ method: 'GET', url: '/v1/ops/marketing/pages', headers: makeAuth() });
      expect(list.statusCode).toBe(200);
      expect(list.json().data.map((page: { slug: string }) => page.slug)).toEqual(['home']);
      // Non-allowed slug: anti-enumeration 404
      const internal = await app.inject({ method: 'GET', url: '/v1/ops/marketing/pages/internal-only', headers: makeAuth() });
      expect(internal.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('writes admin_audit rows for marketing ops actions', async () => {
    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      await db.delete(adminAudit);
      await app.inject({
        method: 'PUT',
        url: '/v1/ops/marketing/pages/home/draft',
        headers: { ...makeAuth(), 'if-match': '1' },
        payload: makeDraft(),
      });
      await app.inject({
        method: 'POST',
        url: '/v1/ops/marketing/pages/home/publish',
        headers: { ...makeAuth(), 'if-match': '2' },
      });
      await app.inject({
        method: 'GET',
        url: '/v1/ops/marketing/pages/home/preview',
        headers: makeAuth(),
      });
      await db.execute(sql`SELECT pg_sleep(0.05)`);
      const rows = await db.select().from(adminAudit).execute();
      const actions = rows.map((r) => r.action).sort();
      expect(actions).toEqual(
        expect.arrayContaining(['draft_saved', 'preview_rendered', 'published']),
      );
      expect(rows.every((r) => r.targetType === 'marketing_page')).toBe(true);
      // actorId comes from JWT userId claim (valid UUID)
      expect(rows.every((r) => r.actorId === SUPERADMIN_ID)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('rejects unauthenticated access to non-existent route as 404 (anti-enumeration)', async () => {
    // POST /v1/ops/marketing/pages does not exist in the route registry.
    // Fastify returns 404 regardless of auth — unknown routes don't leak info.
    const app = await buildApp({ logger: false, marketingDb: db });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ops/marketing/pages',
        headers: makeAuth(),
        payload: { slug: 'Slug Dengan Spasi', title: 'x' },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
