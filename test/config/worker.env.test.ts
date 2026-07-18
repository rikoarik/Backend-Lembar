import { describe, expect, it } from 'vitest';

import { parseWorkerEnv } from '../../src/config/worker.env.js';
import { ConfigError } from '../../src/config/errors.js';

describe('parseWorkerEnv', () => {
  it('returns dev defaults', () => {
    const cfg = parseWorkerEnv({});
    expect(cfg.workerName).toBe('lembar-worker');
    expect(cfg.workerConcurrency).toBe(1);
    expect(cfg.appEnv).toBe('local');
  });

  it('parses provided values', () => {
    const cfg = parseWorkerEnv({
      WORKER_NAME: 'export-worker',
      WORKER_CONCURRENCY: '4',
      APP_ENV: 'preview',
    });
    expect(cfg.workerName).toBe('export-worker');
    expect(cfg.workerConcurrency).toBe(4);
    expect(cfg.appEnv).toBe('preview');
  });

  it('rejects invalid concurrency', () => {
    expect(() => parseWorkerEnv({ WORKER_CONCURRENCY: '0' })).toThrow(ConfigError);
    expect(() => parseWorkerEnv({ WORKER_CONCURRENCY: '99' })).toThrow(ConfigError);
    expect(() => parseWorkerEnv({ WORKER_CONCURRENCY: 'lots' })).toThrow(ConfigError);
  });

  it('redaction: error message never contains the offending value', () => {
    try {
      parseWorkerEnv({ WORKER_CONCURRENCY: 'super-secret-99' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const e = err as ConfigError;
      expect(e.message).toContain('WORKER_CONCURRENCY');
      expect(e.message).not.toContain('super-secret-99');
    }
  });
});
