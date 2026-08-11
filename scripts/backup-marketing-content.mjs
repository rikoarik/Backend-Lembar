import pg from 'pg';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

const env = Object.fromEntries(
  readFileSync(resolve('.env'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);
if (!env.DATABASE_URL) throw new Error('DATABASE_URL missing');
const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();
try {
  const [content, versions] = await Promise.all([
    client.query('SELECT * FROM marketing_content ORDER BY kind, slug, locale'),
    client.query('SELECT * FROM marketing_content_versions ORDER BY content_id, version'),
  ]);
  const path = `/home/hermes/backups/lembar/marketing_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(path, JSON.stringify({ backedUpAt: new Date().toISOString(), marketing_content: content.rows, marketing_content_versions: versions.rows }, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(path);
} finally {
  await client.end();
}
