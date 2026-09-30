import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function read(rel: string): Promise<string> {
  return readFile(path.join(projectRoot, rel), 'utf8');
}

describe('CI quality gate', () => {
  it('exposes gate and secret-scan as repo scripts', async () => {
    const scripts = (JSON.parse(await read('package.json')) as { scripts: Record<string, string> })
      .scripts;

    expect(scripts['secret:scan']).toBe('node scripts/secret-scan.mjs');
    expect(scripts['gate']).toBe('bash scripts/quality-gate.sh');
  });

  it('runs the AGENTS.md gate sequence in order, fail-fast', async () => {
    const gate = await read('scripts/quality-gate.sh');

    const order = [
      'pnpm install --frozen-lockfile',
      'pnpm typecheck',
      'pnpm lint',
      'pnpm format:check',
      'pnpm test',
      'pnpm test:db',
      'pnpm openapi:validate',
      'pnpm openapi:breaking',
      'pnpm secret:scan',
    ];

    let cursor = -1;
    for (const command of order) {
      const at = gate.indexOf(command, cursor + 1);
      expect(at, `${command} must appear after the previous gate step`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('blocks the dev deploy on the gate job', async () => {
    const workflow = await read('.github/workflows/deploy-backend.yml');

    expect(workflow).toMatch(/^ {2}gate:$/m);
    expect(workflow).toMatch(/^ {2}deploy:$/m);
    // The deploy job must depend on the gate job, otherwise a red gate would
    // not block the production deploy — the whole point of this file.
    expect(workflow).toMatch(/needs:\s*gate/);
  });

  it('keeps the secret-scan allowlist reasoned and the pattern set documented', async () => {
    const scanner = await read('scripts/secret-scan.mjs');
    const allow = await read('scripts/secret-scan.allow');

    // The scanner must keep refusing un-reasoned suppressions.
    expect(scanner).toContain('needs a reason');
    // Documented rejection of the noisy entropy sweep.
    expect(scanner).toContain('entropy sweep');
    expect(allow).toContain('Never add an entry for a real credential');
  });
});
