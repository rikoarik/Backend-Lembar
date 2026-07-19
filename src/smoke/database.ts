import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDatabaseEnv } from '../config/database.env.js';
import { ConfigError, formatConfigError } from '../config/errors.js';
import { closeDatabase, createDatabase, healthcheck } from '../infrastructure/database/db.js';
import {
  schools,
  tenants,
  users,
  type School,
  type Tenant,
  type User,
} from '../infrastructure/database/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const migrationsFolder = path.join(projectRoot, 'src', 'infrastructure', 'database', 'migrations');

interface SmokeSummary {
  status: 'ok' | 'error';
  migrations: { folder: string; applied: boolean };
  tenant: { id: string; slug: string };
  user: { id: string; email: string; role: string };
  school: { id: string; name: string; level: string };
  tenantIsolation: { otherTenantId: string; userCount: number };
  healthcheck: { ok: boolean; latencyMs: number };
}

function emit(summary: SmokeSummary): void {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

function emitError(stage: string, err: unknown): never {
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : 'unknown error';
  process.stderr.write(`${JSON.stringify({ status: 'error', stage, error: { name, message } })}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  let env;
  try {
    env = parseDatabaseEnv(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${formatConfigError(err.issues)}\n`);
      process.exit(1);
    }
    emitError('config', err);
  }
  if (!env.url) {
    process.stderr.write('DATABASE_URL is required for db:smoke\n');
    process.exit(1);
  }

  const db = createDatabase({
    connectionString: env.url,
    poolMax: env.poolMax,
    ssl: env.sslMode === 'require',
  });

  try {
    await migrate(db, { migrationsFolder });

    const tenantSlug = `smoke-${Date.now()}`;
    const inserted = await db.transaction(async (tx) => {
      const [tenant] = await tx
        .insert(tenants)
        .values({ slug: tenantSlug, name: 'Smoke Tenant' })
        .returning();
      if (!tenant) throw new Error('tenant insert returned no row');
      const [user] = await tx
        .insert(users)
        .values({ tenantId: tenant.id, email: 'smoke@example.test', role: 'school_admin' })
        .returning();
      if (!user) throw new Error('user insert returned no row');
      const [school] = await tx
        .insert(schools)
        .values({ tenantId: tenant.id, name: 'Smoke School', level: 'sd' })
        .returning();
      if (!school) throw new Error('school insert returned no row');
      return { tenant, user, school };
    });

    const [readTenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, inserted.tenant.id))
      .limit(1);
    if (!readTenant) throw new Error('tenant select returned no row');

    const [otherTenantRow] = await db
      .insert(tenants)
      .values({ slug: `${tenantSlug}-other`, name: 'Other Tenant' })
      .returning();
    if (!otherTenantRow) throw new Error('other tenant insert returned no row');

    const tenantUsers = await db
      .select()
      .from(users)
      .where(and(eq(users.tenantId, inserted.tenant.id), eq(users.email, inserted.user.email)));
    if (tenantUsers.length !== 1)
      throw new Error(`expected 1 user for tenant, found ${tenantUsers.length}`);

    const isolatedUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.tenantId, otherTenantRow.id));
    if (isolatedUsers.length !== 0) {
      throw new Error(
        `tenant isolation broken: found ${isolatedUsers.length} users for unrelated tenant`,
      );
    }

    const health = await healthcheck(db);

    const summary: SmokeSummary = {
      status: 'ok',
      migrations: { folder: migrationsFolder, applied: true },
      tenant: { id: inserted.tenant.id, slug: inserted.tenant.slug },
      user: { id: inserted.user.id, email: inserted.user.email, role: inserted.user.role },
      school: { id: inserted.school.id, name: inserted.school.name, level: inserted.school.level },
      tenantIsolation: { otherTenantId: otherTenantRow.id, userCount: isolatedUsers.length },
      healthcheck: { ok: health.ok, latencyMs: health.latencyMs },
    };
    emit(summary);

    await cleanupTenant(db, inserted.tenant.id);
    await cleanupTenant(db, otherTenantRow.id);
  } catch (err) {
    emitError('runtime', err);
  } finally {
    await closeDatabase(db);
  }
}

async function cleanupTenant(
  db: ReturnType<typeof createDatabase>,
  tenantId: string,
): Promise<void> {
  const t: Tenant | undefined = (
    await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1)
  )[0];
  const u: User[] = await db.select().from(users).where(eq(users.tenantId, tenantId));
  const s: School[] = await db.select().from(schools).where(eq(schools.tenantId, tenantId));
  if (t)
    process.stdout.write(
      `${JSON.stringify({ cleanup: 'tenant', id: t.id, slug: t.slug, users: u.length, schools: s.length })}\n`,
    );
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('smoke/database.js') === true;

if (isDirectRun) {
  await main();
}
