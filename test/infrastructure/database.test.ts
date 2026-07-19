import { existsSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';

import {
  closeDatabase,
  createDatabase,
  healthcheck,
} from '../../src/infrastructure/database/db.js';
import { tenants } from '../../src/infrastructure/database/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const migrationsFolder = path.join(projectRoot, 'src', 'infrastructure', 'database', 'migrations');

const hasUrl =
  typeof process.env['DATABASE_URL'] === 'string' && process.env['DATABASE_URL'].length > 0;
const skipReason = 'DB smoke skipped without DATABASE_URL';

describe.skipIf(!hasUrl)('database spike', () => {
  if (!hasUrl) {
    it(skipReason, () => {
      expect(skipReason).toBe(skipReason);
    });
    return;
  }

  const db = createDatabase({ connectionString: process.env['DATABASE_URL'] ?? '' });
  if (!existsSync(migrationsFolder)) {
    throw new Error(`migrations folder missing: ${migrationsFolder}`);
  }

  afterAll(async () => {
    await closeDatabase(db);
  });

  it('migrates, inserts, selects, and healthchecks', async () => {
    await migrate(db, { migrationsFolder });
    const slug = `vitest-${Date.now()}`;
    const [row] = await db.insert(tenants).values({ slug, name: 'Vitest Tenant' }).returning();
    expect(row?.slug).toBe(slug);
    const [read] = await db.select().from(tenants).where(eq(tenants.id, row!.id)).limit(1);
    expect(read?.id).toBe(row!.id);
    const health = await healthcheck(db);
    expect(health.ok).toBe(true);
    if (read) {
      await db.delete(tenants).where(eq(tenants.id, read.id));
    }
  }, 15_000);
});
