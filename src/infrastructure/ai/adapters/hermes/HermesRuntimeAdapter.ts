import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { stringify } from 'yaml';
import { fingerprint } from '../../../../common/redact.js';
import type {
  AiAdapterMeta,
  AiGenerateInput,
  AiGenerateOutcome,
  AiGenerateResult,
  ProductAiAdapter,
} from '../../domain/ProductAiAdapter.js';
import type { AiEnv } from '../../../../config/ai.env.js';

/** Lembar calls this isolated Hermes runtime, never the selected provider directly. */
export class HermesRuntimeAdapter implements ProductAiAdapter {
  readonly meta: AiAdapterMeta;

  constructor(private readonly env: AiEnv) {
    this.meta = { driver: 'hermes', providerModelId: env.modelId };
  }

  async generate(input: AiGenerateInput): Promise<AiGenerateResult> {
    const home = await mkdtemp(join(tmpdir(), 'lembar-hermes-'));
    try {
      await writeFile(join(home, 'config.yaml'), stringify(runtimeConfig(this.env)), { mode: 0o600 });
      const result = await runHermes(home, input.prompt, this.env.timeoutMs);
      if (!result.ok) return { ok: true, value: result.outcome };
      try {
        JSON.parse(result.text);
      } catch {
        return { ok: true, value: {
          kind: 'schema_invalid', providerModelId: input.modelOverride ?? this.env.modelId,
          redactedResponseFingerprint: fingerprint(`hermes:parse:${result.text.length}`),
          reason: 'parse_error', responseText: result.text,
        } };
      }
      return { ok: true, value: {
        kind: 'succeeded', promptTemplateId: input.promptTemplateId,
        requestTokensEstimate: input.tokenEstimateHint ?? Math.ceil(input.prompt.length / 4),
        responseText: result.text, providerModelId: input.modelOverride ?? this.env.modelId,
        providerRequestId: null,
      } };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}

export function runtimeConfig(env: AiEnv): Record<string, unknown> {
  const providers: Array<Record<string, string>> = [{
    name: 'lembar-primary', base_url: env.hermesBaseUrl, api_key: env.hermesApiKey ?? '', model: env.modelId,
  }];
  if (env.openaiApiKey) providers.push({
    name: 'lembar-fallback', base_url: env.openaiBaseUrl, api_key: env.openaiApiKey, model: env.openaiModelId,
  });
  return {
    model: {
      provider: 'custom:lembar-primary', default: env.modelId, max_tokens: env.maxTokens,
      extra_headers: { 'User-Agent': 'Lembar Hermes Runtime' },
    },
    ...(env.openaiApiKey ? { fallback_model: { provider: 'custom:lembar-fallback', model: env.openaiModelId } } : {}),
    custom_providers: providers,
    toolsets: ['safe'],
  };
}

async function runHermes(home: string, prompt: string, timeoutMs: number): Promise<{ ok: true; text: string } | { ok: false; outcome: AiGenerateOutcome }> {
  return new Promise((resolve) => {
    const child = spawn(process.env.HERMES_RUNTIME_BIN ?? 'hermes', ['--oneshot', prompt, '--ignore-rules', '--toolsets', 'safe'], {
      env: { ...process.env, HERMES_HOME: home, HERMES_ACCEPT_HOOKS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, outcome: { kind: 'error', providerModelId: 'hermes-runtime', redactedReasonFingerprint: fingerprint('hermes:spawn'), retryable: true } });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) return resolve({ ok: true, text: stdout.trim() });
      const rateLimited = /429|rate.limit|quota/i.test(stderr);
      resolve({ ok: false, outcome: rateLimited
        ? { kind: 'rate_limited', providerModelId: 'hermes-runtime', retryAfterMs: 1_000, redactedReasonFingerprint: fingerprint('hermes:rate-limited') }
        : { kind: 'error', providerModelId: 'hermes-runtime', redactedReasonFingerprint: fingerprint(`hermes:exit:${code ?? 'signal'}:${stderr.length}`), retryable: code !== 0 } });
    });
  });
}
