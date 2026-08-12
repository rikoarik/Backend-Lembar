import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('isolated PostgreSQL integration-test environment', () => {
  it('uses a loopback-only test database and pins test:db to it', async () => {
    const [compose, packageJson] = await Promise.all([
      readFile(path.join(projectRoot, 'compose.test.yaml'), 'utf8'),
      readFile(path.join(projectRoot, 'package.json'), 'utf8'),
    ]);
    const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;

    expect(compose).toContain('127.0.0.1:55432:5432');
    expect(compose).toContain('POSTGRES_DB: lembar_test');
    expect(compose).not.toContain('volumes:');
    expect(scripts['test:db']).toContain('node scripts/prepare-test-db.mjs');
    expect(scripts['test:db']).toContain(
      'postgres://lembar_test:lembar_test@127.0.0.1:55432/lembar_test',
    );

    const duplicateMarketingMigration = await readFile(
      path.join(projectRoot, 'src/infrastructure/database/migrations/0009_superb_epoch.sql'),
      'utf8',
    );
    expect(duplicateMarketingMigration).toContain('ADD COLUMN IF NOT EXISTS "revision"');

    for (const testFile of [
      'test/modules/auth/routes.test.ts',
      'test/modules/x1/x1-01-identity-workspace-gate.test.ts',
    ]) {
      const source = await readFile(path.join(projectRoot, testFile), 'utf8');
      expect(source).not.toContain("readFileSync(envPath, 'utf-8')");
      expect(source).not.toContain("process.env['DATABASE_URL'] = match[1]");
    }
  });
});
