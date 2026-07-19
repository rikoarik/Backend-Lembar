import { describe, expect, it } from 'vitest';

import { parseAiEnv } from '../../../src/config/ai.env.js';

describe('parseAiEnv', () => {
  it('defaults to mock driver and a non-secret model id', () => {
    const env = parseAiEnv({});
    expect(env.driver).toBe('mock');
    expect(env.modelId).toBe('mock-fixture-v1');
    expect(env.apiKeyPresent).toBe(false);
    expect(env.schemaRepairMaxAttempts).toBe(1);
  });

  it('rejects openai when requested without a key', () => {
    expect(() => parseAiEnv({ AI_DRIVER: 'openai' })).toThrow(
      'AI_DRIVER: openai requires a non-empty OPENAI_API_KEY env var',
    );
  });

  it('honors openai when explicitly opted in with a key (still safe default if key absent)', () => {
    const env = parseAiEnv({ AI_DRIVER: 'openai', OPENAI_API_KEY: 'preview-only' });
    expect(env.driver).toBe('openai');
    expect(env.apiKeyPresent).toBe(true);
  });

  it('rejects out-of-range integers', () => {
    expect(() => parseAiEnv({ AI_SCHEMA_REPAIR_MAX: '99' })).toThrow(
      'AI_SCHEMA_REPAIR_MAX: must be an integer in 0..5',
    );
  });

  it('parses an http(s) base URL', () => {
    const env = parseAiEnv({ AI_BASE_URL: 'https://api.openai.example/v1' });
    expect(env.baseUrl).toBe('https://api.openai.example/v1');
  });

  it('rejects non-http base urls', () => {
    const env = parseAiEnv({ AI_BASE_URL: 'javascript:alert(1)' });
    expect(env.baseUrl).toBeNull();
  });
});
