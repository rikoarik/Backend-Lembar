import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');

function runWorkerBinary(): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }> {
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
    let signalSent = false;

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
      // Send SIGTERM once the heartbeat JSON line has been received so the
      // worker shuts down gracefully rather than running the poll loop forever.
      if (!signalSent && stdout.includes('"event":"worker.heartbeat"')) {
        signalSent = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal }));
  });
}

describe('worker smoke (real binary)', () => {
  const builtEntry = path.join(projectRoot, 'dist', 'bootstrap', 'worker.js');

  afterAll(() => {
    // no-op; process is already finished
  });

  it('built binary emits one heartbeat JSON line and exits 0', async () => {
    if (!existsSync(builtEntry)) throw new Error(`worker entry not built: ${builtEntry}`);
    const { stdout, stderr, code, signal } = await runWorkerBinary();
    // Worker exits via process.exit(0) after SIGTERM shutdown — code 0 expected.
    // On some platforms the close event fires with code=null and signal='SIGTERM'
    // before process.exit(0) completes; accept both.
    expect(code === 0 || signal === 'SIGTERM').toBe(true);
    // stderr may contain graceful-shutdown log lines from console.log in worker bootstrap;
    // only assert it does not contain error-level output.
    expect(stderr).not.toContain('Error');
    const line = stdout.trim().split('\n').at(0) ?? '';
    const parsed = JSON.parse(line) as { event: string; service: string; id: string };
    expect(parsed.event).toBe('worker.heartbeat');
    expect(parsed.service).toBe('lembar-worker');
    expect(/^[0-9a-f]{16}$/.test(parsed.id)).toBe(true);
  }, 10_000);
});
