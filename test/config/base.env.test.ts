import { describe, expect, it } from 'vitest';

import { parseBaseEnv } from '../../src/config/base.env.js';
import { ConfigError } from '../../src/config/errors.js';

describe('parseBaseEnv', () => {
  it('returns safe local defaults when env is empty', () => {
    const cfg = parseBaseEnv({});
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.appEnv).toBe('local');
    expect(cfg.serviceName).toBe('lembar-backend');
    expect(cfg.serviceVersion).toBe('0.0.0-dev');
    expect(cfg.logLevel).toBe('info');
  });

  it('parses test environment', () => {
    const cfg = parseBaseEnv({
      NODE_ENV: 'test',
      APP_ENV: 'test',
      SERVICE_NAME: 'lembar-api-test',
      SERVICE_VERSION: '0.1.0',
      LOG_LEVEL: 'debug',
    });
    expect(cfg.nodeEnv).toBe('test');
    expect(cfg.appEnv).toBe('test');
    expect(cfg.serviceName).toBe('lembar-api-test');
    expect(cfg.serviceVersion).toBe('0.1.0');
    expect(cfg.logLevel).toBe('debug');
  });

  it('accepts production APP_ENV', () => {
    const cfg = parseBaseEnv({
      APP_ENV: 'production',
      LOG_LEVEL: 'warn',
    });
    expect(cfg.appEnv).toBe('production');
    expect(cfg.logLevel).toBe('warn');
  });

  it('rejects unknown log level without leaking the value', () => {
    try {
      parseBaseEnv({ LOG_LEVEL: 'loud' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const e = err as ConfigError;
      const redacted = e.issues.map((i) => `${i.key}: ${i.reason}`).join('; ');
      expect(redacted).toContain('LOG_LEVEL');
      expect(redacted).not.toContain('loud');
      expect(e.message).not.toContain('loud');
    }
  });

  it('treats empty strings as missing', () => {
    const cfg = parseBaseEnv({
      SERVICE_NAME: '   ',
      LOG_LEVEL: '',
    });
    expect(cfg.serviceName).toBe('lembar-backend');
    expect(cfg.logLevel).toBe('info');
  });
});
