import { Client } from 'pg';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const connectionString = process.env['DATABASE_URL'];
if (!connectionString) {
  throw new Error('DATABASE_URL must be set for the isolated test database');
}

const url = new URL(connectionString);
const expected = {
  hostname: '127.0.0.1',
  port: '55432',
  pathname: '/lembar_test',
  username: 'lembar_test',
};

for (const [field, expectedValue] of Object.entries(expected)) {
  if (url[field] !== expectedValue) {
    throw new Error(`Refusing to prepare a non-test database: expected ${field}=${expectedValue}`);
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'src', 'infrastructure', 'database', 'migrations');

// All .sql files, sorted — this is what the schema actually looks like
const migrations = (await readdir(migrationsDir))
  .filter((file) => file.endsWith('.sql'))
  .sort((left, right) => left.localeCompare(right));

// Drizzle migration metadata, keyed by hash — used to pre-populate __drizzle_migrations
// so that drizzle's migrate() in tests sees everything as already applied and skips re-runs.
const drizzleMigrations = readMigrationFiles({ migrationsFolder: migrationsDir });

const client = new Client({ connectionString });
await client.connect();
try {
  await client.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;');

  // Apply all raw SQL migrations
  for (const migration of migrations) {
    const sql = await readFile(path.join(migrationsDir, migration), 'utf8');
    await client.query(sql);
  }

  // Pre-populate drizzle's tracking table so migrate() is a no-op in tests.
  // Drizzle defaults to the "drizzle" schema (not "public").
  await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await client.query(`
    CREATE TABLE drizzle."__drizzle_migrations" (
      id serial PRIMARY KEY NOT NULL,
      hash text NOT NULL,
      created_at bigint
    )
  `);
  for (const m of drizzleMigrations) {
    await client.query(
      'INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
      [m.hash, m.folderMillis],
    );
  }

  console.log(
    `Prepared isolated test database: ${migrations.length} SQL migrations applied,` +
      ` ${drizzleMigrations.length} drizzle migration hashes recorded.`,
  );
} finally {
  await client.end();
}
