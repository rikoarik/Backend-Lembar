// Diagnostic: dump marketing_content + published version payload for kind=page slug=home.
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
  `select c.kind, c.slug, c.locale, c.state, c.published_version, v.payload
   from marketing_content c
   left join marketing_content_versions v on v.content_id = c.id and v.version = c.published_version
   where c.kind in ('global','page')
   order by c.kind, c.slug`,
);
for (const row of r.rows) {
  console.log('---', row.kind, row.slug, 'state=', row.state, 'pubVer=', row.published_version);
  if (row.payload) console.log(JSON.stringify(row.payload, null, 2));
  else console.log('(no published version row)');
}
await c.end();