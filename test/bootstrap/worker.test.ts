import { describe, expect, it } from 'vitest';
import {
  buildHeartbeat,
  resolveWorkerOptions,
  type Heartbeat,
} from '../../src/bootstrap/worker.js';

describe('worker heartbeat', () => {
  it('emits a structured, secret-free payload', () => {
    const opts = resolveWorkerOptions({ WORKER_NAME: 'lembar-worker' });
    const hb = buildHeartbeat(opts, new Date('2026-01-01T00:00:00.000Z'));

    expect(hb.event).toBe('worker.heartbeat');
    expect(hb.service).toBe('lembar-worker');
    expect(hb.name).toBe('lembar-worker');
    expect(hb.emittedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(/^[0-9a-f]{16}$/.test(hb.id)).toBe(true);

    const forbidden = ['password', 'token', 'secret', 'api_key', 'apikey', 'Bearer'];
    for (const f of forbidden) {
      expect(JSON.stringify(hb).toLowerCase()).not.toContain(f.toLowerCase());
    }
  });

  it('id is deterministic for the same inputs', () => {
    const opts = resolveWorkerOptions({ WORKER_NAME: 'lembar-worker' });
    const a = buildHeartbeat(opts);
    const b = buildHeartbeat(opts);
    expect(a.id).toBe(b.id);
  });

  it('resolveWorkerOptions defaults name when env missing', () => {
    const opts = resolveWorkerOptions({});
    expect(opts.name).toBe('lembar-worker');
    expect(typeof opts.version).toBe('string');
  });

  it('parses heartbeat JSON round-trip', () => {
    const opts = resolveWorkerOptions({ WORKER_NAME: 'lembar-worker' });
    const hb: Heartbeat = buildHeartbeat(opts);
    const round = JSON.parse(JSON.stringify(hb)) as Heartbeat;
    expect(round).toEqual(hb);
  });
});
