import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');

function runWorkerBinary(): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const entry = path.join(projectRoot, 'dist', 'bootstrap', 'worker.js');
    if (!existsSync(entry)) {
      reject(new Error(`worker entry not built: ${entry}`));
      return;
    }
    const child = spawn(process.execPath, [entry], {
      cwd: projectRoot,
      env: { ...process.env, WORKER_NAME: 'lembar-worker' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

describe('worker smoke (real binary)', () => {
  const builtEntry = path.join(projectRoot, 'dist', 'bootstrap', 'worker.js');

  afterAll(() => {
    // no-op; process is already finished
  });

  it('built binary emits one heartbeat JSON line and exits 0', async () => {
    if (!existsSync(builtEntry)) throw new Error(`worker entry not built: ${builtEntry}`);
    const { stdout, stderr, code } = await runWorkerBinary();
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const line = stdout.trim().split('\n').at(-1) ?? '';
    const parsed = JSON.parse(line) as { event: string; service: string; id: string };
    expect(parsed.event).toBe('worker.heartbeat');
    expect(parsed.service).toBe('lembar-worker');
    expect(/^[0-9a-f]{16}$/.test(parsed.id)).toBe(true);
  }, 10_000);
});
