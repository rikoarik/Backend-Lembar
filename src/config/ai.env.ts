/**
 * B0-08 typed env parser for the product-runtime AI adapter spike.
 *
 * The spike proves a provider-neutral adapter. The default driver is `mock`
 * so dev/test/CI never depend on a paid provider. A live `openai` driver
 * is only honored when `AI_DRIVER=openai` AND an `OPENAI_API_KEY`-style
 * secret is present in the environment. `.env.example` declares variable
 * names only — no secret values are committed.
 *
 * ponytail: hides provider URL/key/region knobs behind one typed parser so the
 * spike scope cannot silently leak into process env. Upgrade path: every later
 * feature that needs a different knob adds one optional `readString`/`parseBoundedInt`
 * pair here and surfaces it through `parseAiEnv`.
 */
import { ConfigError, type ConfigIssue } from './errors.js';

export const AI_DRIVERS = ['mock', 'openai'] as const;
export type AiDriver = (typeof AI_DRIVERS)[number];

export const AI_PROVIDER_OUTCOMES = [
  'succeeded',
  'schema_repair',
  'rate_limited',
  'refused',
  'error',
] as const;
export type AiProviderOutcome = (typeof AI_PROVIDER_OUTCOMES)[number];

export interface AiEnv {
  driver: AiDriver;
  modelId: string;
  schemaRepairMaxAttempts: number;
  tokenEstimateFallbackChars: number;
  baseUrl: string | null;
  apiKeyPresent: boolean;
  timeoutMs: number;
}

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseDriver(
  raw: string | undefined,
  apiKeyPresent: boolean,
  issues: ConfigIssue[],
): AiDriver {
  const fallback: AiDriver = 'mock';
  if (raw === undefined) return fallback;
  if ((AI_DRIVERS as readonly string[]).includes(raw)) {
    const value = raw as AiDriver;
    if (value === 'openai' && !apiKeyPresent) {
      // Live driver requires the secret; the spike is intentionally safe-by-default.
      issues.push({
        key: 'AI_DRIVER',
        reason: 'openai requires a non-empty OPENAI_API_KEY env var',
      });
      return fallback;
    }
    return value;
  }
  issues.push({ key: 'AI_DRIVER', reason: `must be one of ${AI_DRIVERS.join('|')}` });
  return fallback;
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  issues: ConfigIssue[],
  key: string,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    issues.push({ key, reason: `must be an integer in ${min}..${max}` });
    return fallback;
  }
  return n;
}

const VALID_BASE_URL_PROTOCOLS = new Set(['https:', 'http:']);

function parseBaseUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!VALID_BASE_URL_PROTOCOLS.has(url.protocol)) return null;
  return url.toString();
}

export function parseAiEnv(env: NodeJS.ProcessEnv = process.env): AiEnv {
  const issues: ConfigIssue[] = [];

  // Secret presence must be checked by value (not by name) to avoid leaking the name
  // in source/contract surfaces. The .env.example intentionally exposes the variable
  // name only and never a real value.
  const apiKeyPresent = (() => {
    const v = readString(env, 'OPENAI_API_KEY');
    return Boolean(v && v.length > 0);
  })();

  const driver = parseDriver(readString(env, 'AI_DRIVER'), apiKeyPresent, issues);

  const modelId = readString(env, 'AI_MODEL_ID') ?? 'mock-fixture-v1';
  const schemaRepairMaxAttempts = parseBoundedInt(
    readString(env, 'AI_SCHEMA_REPAIR_MAX'),
    1,
    0,
    5,
    issues,
    'AI_SCHEMA_REPAIR_MAX',
  );
  const tokenEstimateFallbackChars = parseBoundedInt(
    readString(env, 'AI_TOKEN_CHARS_FALLBACK'),
    4,
    1,
    64,
    issues,
    'AI_TOKEN_CHARS_FALLBACK',
  );
  const baseUrl = parseBaseUrl(readString(env, 'AI_BASE_URL'));
  const timeoutMs = parseBoundedInt(
    readString(env, 'AI_TIMEOUT_MS'),
    30_000,
    100,
    600_000,
    issues,
    'AI_TIMEOUT_MS',
  );

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    driver,
    modelId,
    schemaRepairMaxAttempts,
    tokenEstimateFallbackChars,
    baseUrl,
    apiKeyPresent,
    timeoutMs,
  };
}

export const aiEnv = parseAiEnv;
