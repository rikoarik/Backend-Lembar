import { describe, expect, it } from 'vitest';
import { runtimeConfig } from '../../../src/infrastructure/ai/adapters/hermes/HermesRuntimeAdapter.js';

const env = {
  modelId: 'primary-model',
  hermesBaseUrl: 'https://provider.example/v1',
  hermesApiKey: 'primary-key',
  openaiBaseUrl: 'https://fallback.example/v1',
  openaiApiKey: 'fallback-key',
  openaiModelId: 'fallback-model',
  maxTokens: 777,
} as any;

describe('HermesRuntimeAdapter config', () => {
  it('keeps Lembar provider-agnostic by configuring an isolated Hermes custom provider', () => {
    expect(runtimeConfig(env)).toMatchObject({
      model: { provider: 'custom:lembar-primary', default: 'primary-model', max_tokens: 777, extra_headers: { 'User-Agent': 'Lembar Hermes Runtime' } },
      fallback_model: { provider: 'custom:lembar-fallback', model: 'fallback-model' },
      custom_providers: [
        { name: 'lembar-primary', base_url: 'https://provider.example/v1', api_key: 'primary-key' },
        { name: 'lembar-fallback', base_url: 'https://fallback.example/v1', api_key: 'fallback-key' },
      ],
    });
  });

  it('does not configure a fallback runtime provider without a fallback key', () => {
    const config = runtimeConfig({ ...env, openaiApiKey: null });
    expect(config).not.toHaveProperty('fallback_model');
    expect((config.custom_providers as unknown[])).toHaveLength(1);
  });
});
