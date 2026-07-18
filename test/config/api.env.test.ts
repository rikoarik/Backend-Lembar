import { describe, expect, it } from 'vitest';

import { parseApiEnv } from '../../src/config/api.env.js';
import { ConfigError } from '../../src/config/errors.js';

describe('parseApiEnv', () => {
  it('returns dev defaults', () => {
    const cfg = parseApiEnv({});
    expect(cfg.port).toBe(4000);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.corsAllowedOrigins).toEqual([]);
    expect(cfg.publicAppUrl).toBe('http://localhost:3000');
    expect(cfg.appEnv).toBe('local');
    expect(cfg.logLevel).toBe('info');
  });

  it('parses test profile values', () => {
    const cfg = parseApiEnv({
      APP_ENV: 'test',
      API_PORT: '5050',
      API_HOST: '0.0.0.0',
      CORS_ALLOWED_ORIGINS: 'http://localhost:5173, http://localhost:4173',
      PUBLIC_APP_URL: 'http://localhost:5173',
      LOG_LEVEL: 'silent',
    });
    expect(cfg.appEnv).toBe('test');
    expect(cfg.port).toBe(5050);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.corsAllowedOrigins).toEqual(['http://localhost:5173', 'http://localhost:4173']);
    expect(cfg.publicAppUrl).toBe('http://localhost:5173');
    expect(cfg.logLevel).toBe('silent');
  });

  it('rejects invalid port', () => {
    expect(() => parseApiEnv({ API_PORT: '0' })).toThrow(ConfigError);
    expect(() => parseApiEnv({ API_PORT: '70000' })).toThrow(ConfigError);
    expect(() => parseApiEnv({ API_PORT: 'abc' })).toThrow(ConfigError);
  });

  it('rejects wildcard CORS origin', () => {
    expect(() => parseApiEnv({ CORS_ALLOWED_ORIGINS: '*' })).toThrow(ConfigError);
  });

  it('requires PUBLIC_APP_URL in production strict mode', () => {
    expect(() => parseApiEnv({ APP_ENV: 'production' })).toThrow(ConfigError);
  });

  it('accepts production with explicit PUBLIC_APP_URL', () => {
    const cfg = parseApiEnv({
      APP_ENV: 'production',
      PUBLIC_APP_URL: 'https://app.example.com',
    });
    expect(cfg.appEnv).toBe('production');
    expect(cfg.publicAppUrl).toBe('https://app.example.com');
  });

  it('redaction: error message lists key but never the offending value', () => {
    try {
      parseApiEnv({ API_PORT: 'evil-secret-value' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const e = err as ConfigError;
      expect(e.message).toContain('API_PORT');
      expect(e.message).not.toContain('evil-secret-value');
      const flat = e.issues.map((i) => `${i.key}: ${i.reason}`).join('; ');
      expect(flat).not.toContain('evil-secret-value');
    }
  });
});
