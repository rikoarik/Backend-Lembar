/**
 * Seeds only finite, schema-valid, published marketing CMS documents.
 * Usage: node scripts/seed-marketing-global.mjs
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MARKETING_PUBLISHED_SEED_DOCUMENTS } from './marketing-published-seed.mjs';

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
  }

  await client.query(
    `INSERT INTO marketing_content_versions (content_id, version, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT DO NOTHING`,
    [contentId, version, JSON.stringify(payload)],
  );
  await client.query(
    `UPDATE marketing_content SET published_version = $2, current_version = GREATEST(current_version, $2), state = 'published' WHERE id = $1`,
    [contentId, version],
  );
  console.log(`Seeded ${kind}/${slug} version ${version}`);
}

try {
  for (const document of MARKETING_PUBLISHED_SEED_DOCUMENTS) {
    await upsertPublished(document.kind, document.slug, document.payload);
  }
  console.log('Marketing seed OK');
} catch (err) {
  console.error('Seed failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
