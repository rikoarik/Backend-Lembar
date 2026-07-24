/**
 * Seed published marketing global content so GET /v1/public/marketing/global works.
 * Usage: node scripts/seed-marketing-global.mjs
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');
const envContent = readFileSync(envPath, 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;
  env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
}

const DATABASE_URL = env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}

const globalPayload = {
  navigation: [
    { id: 'nav-home', title: 'Beranda', body: null, mediaAssetId: null, cta: null },
    { id: 'nav-school', title: 'Untuk Sekolah', body: null, mediaAssetId: null, cta: null },
    { id: 'nav-pricing', title: 'Harga', body: null, mediaAssetId: null, cta: null },
  ],
  footer: [
    {
      id: 'footer-about',
      title: 'Tentang lembar',
      body: 'Platform asesmen berbasis kurikulum untuk guru dan sekolah.',
      mediaAssetId: null,
      cta: null,
    },
  ],
  ctas: [
    {
      id: 'cta-start',
      label: 'Mulai gratis',
      href: '/register',
      variant: 'primary',
      placement: 'header',
      audience: 'all',
      trackingKey: 'cta_start_header',
      enabled: true,
      external: false,
      accessibleLabel: 'Mulai gratis',
    },
  ],
};

const pagePayload = {
  schemaVersion: 1,
  blocks: [
    {
      id: 'hero-1',
      type: 'hero',
      eyebrow: 'lembar',
      heading: 'Asesmen kurikulum yang rapi',
      body: 'Buat, review, dan cetak asesmen dengan alur kerja yang jelas.',
      theme: 'light',
      mediaAssetId: null,
      ctas: [
        {
          id: 'hero-cta',
          label: 'Coba sekarang',
          href: '/register',
          variant: 'primary',
          placement: 'hero',
          audience: 'all',
          trackingKey: 'hero_cta',
          enabled: true,
          external: false,
          accessibleLabel: 'Coba sekarang',
        },
      ],
      items: [],
    },
  ],
  seo: {
    title: 'lembar — asesmen untuk guru',
    description: 'Platform asesmen berbasis kurikulum untuk guru dan sekolah.',
    imageAssetId: null,
    noIndex: false,
  },
};

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

async function upsertPublished(kind, slug, payload) {
  const existing = await client.query(
    `SELECT id, published_version FROM marketing_content WHERE kind = $1 AND slug = $2 AND locale = 'id-ID' LIMIT 1`,
    [kind, slug],
  );

  let contentId;
  let version = 1;

  if (existing.rows[0]) {
    contentId = existing.rows[0].id;
    version = (existing.rows[0].published_version ?? 0) + 1;
    await client.query(
      `UPDATE marketing_content
       SET published_version = $2, current_version = $2, state = 'published', revision = revision + 1, updated_by = NULL
       WHERE id = $1`,
      [contentId, version],
    );
  } else {
    const inserted = await client.query(
      `INSERT INTO marketing_content (kind, slug, locale, current_version, published_version, draft_payload, revision, state)
       VALUES ($1, $2, 'id-ID', 1, 1, $3::jsonb, 1, 'published')
       RETURNING id`,
      [kind, slug, JSON.stringify(payload)],
    );
    contentId = inserted.rows[0].id;
    version = 1;
  }

  await client.query(
    `INSERT INTO marketing_content_versions (content_id, version, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT DO NOTHING`,
    [contentId, version, JSON.stringify(payload)],
  );

  // ensure published_version points to this version
  await client.query(
    `UPDATE marketing_content SET published_version = $2, current_version = GREATEST(current_version, $2), state = 'published' WHERE id = $1`,
    [contentId, version],
  );

  console.log(`Seeded ${kind}/${slug} version ${version}`);
}

try {
  await upsertPublished('global', '__global__', globalPayload);
  await upsertPublished('page', 'home', pagePayload);
  console.log('Marketing seed OK');
} catch (err) {
  console.error('Seed failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
