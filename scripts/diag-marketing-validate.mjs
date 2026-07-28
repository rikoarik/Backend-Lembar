// Direct exercise of validator with the actual home payload
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envContent = readFileSync(resolve(__dirname, '../.env'), 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i === -1) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const c = new pg.Client({ connectionString: env.DATABASE_URL });
await c.connect();
const r = await c.query(
  `select v.payload
   from marketing_content c
   join marketing_content_versions v on v.content_id = c.id and v.version = c.published_version
   where c.kind = 'page' and c.slug = 'home' and c.locale = 'id-ID'`,
);
const payload = r.rows[0]?.payload;
console.log('Payload type:', typeof payload, Array.isArray(payload) ? '[array]' : '');
console.log('Payload keys:', payload && typeof payload === 'object' ? Object.keys(payload) : '(none)');
console.log('blocks type:', Array.isArray(payload?.blocks) ? 'array len=' + payload.blocks.length : typeof payload?.blocks);
if (Array.isArray(payload?.blocks) && payload.blocks[0]) {
  console.log('block[0] keys:', Object.keys(payload.blocks[0]));
  for (const [k, v] of Object.entries(payload.blocks[0])) {
    console.log(`  ${k}:`, JSON.stringify(v));
  }
}
console.log('seo keys:', payload?.seo ? Object.keys(payload.seo) : '(none)');
await c.end();