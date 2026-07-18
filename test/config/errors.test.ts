import { describe, expect, it } from 'vitest';

import { ConfigError, formatConfigError } from '../../src/config/errors.js';

describe('ConfigError redaction', () => {
  it('message contains key names and reasons only', () => {
    const err = new ConfigError([
      { key: 'API_PORT', reason: 'must be an integer in 1..65535' },
      { key: 'API_KEY', reason: 'must not be empty' },
    ]);
    expect(err.name).toBe('ConfigError');
    expect(err.message).toBe(
      'API_PORT: must be an integer in 1..65535; API_KEY: must not be empty',
    );
  });

  it('serializes safely via toString', () => {
    const err = new ConfigError([{ key: 'SECRET_X', reason: 'required' }]);
    const s = err.toString();
    expect(s).toContain('ConfigError');
    expect(s).toContain('SECRET_X');
    expect(s).not.toContain('hunter2');
  });

  it('formatConfigError joins issues deterministically', () => {
    expect(formatConfigError([])).toBe('');
    expect(formatConfigError([{ key: 'A', reason: 'r' }])).toBe('A: r');
    expect(
      formatConfigError([
        { key: 'A', reason: 'r1' },
        { key: 'B', reason: 'r2' },
      ]),
    ).toBe('A: r1; B: r2');
  });
});
