import { ConfigError, type ConfigIssue } from './errors.js';

export interface ImageGenerationEnv {
  enabled: boolean;
  apiKey: string | null;
  baseUrl: string;
  modelId: string;
  timeoutMs: number;
}

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function parseBoolean(
  raw: string | undefined,
  fallback: boolean,
  issues: ConfigIssue[],
  key: string,
): boolean {
  if (raw === undefined) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  issues.push({ key, reason: 'must be true|false|1|0' });
  return fallback;
}

function parseTimeout(raw: string | undefined, issues: ConfigIssue[]): number {
  if (raw === undefined) return 90_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 5_000 || value > 180_000) {
    issues.push({ key: 'AI_IMAGE_TIMEOUT_MS', reason: 'must be an integer in 5000..180000' });
    return 90_000;
  }
  return value;
}

function parseBaseUrl(raw: string | undefined, issues: ConfigIssue[]): string {
  const value = raw ?? 'https://api.openai.com';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('invalid protocol');
    return url.toString().replace(/\/$/, '');
  } catch {
    issues.push({ key: 'AI_IMAGE_BASE_URL', reason: 'must be a valid http(s) URL' });
    return 'https://api.openai.com';
  }
}

export function parseImageGenerationEnv(
  env: NodeJS.ProcessEnv = process.env,
): ImageGenerationEnv {
  const issues: ConfigIssue[] = [];
  const apiKey = readString(env, 'AI_IMAGE_API_KEY') ?? readString(env, 'OPENAI_API_KEY') ?? null;
  const enabled = parseBoolean(
    readString(env, 'AI_IMAGE_ENABLED'),
    apiKey !== null,
    issues,
    'AI_IMAGE_ENABLED',
  );
  if (enabled && !apiKey) {
    issues.push({
      key: 'AI_IMAGE_API_KEY',
      reason: 'required when AI_IMAGE_ENABLED=true (OPENAI_API_KEY is accepted as fallback)',
    });
  }

  const result: ImageGenerationEnv = {
    enabled,
    apiKey,
    baseUrl: parseBaseUrl(
      readString(env, 'AI_IMAGE_BASE_URL') ?? readString(env, 'OPENAI_BASE_URL'),
      issues,
    ),
    modelId: readString(env, 'AI_IMAGE_MODEL_ID') ?? 'gpt-image-1',
    timeoutMs: parseTimeout(readString(env, 'AI_IMAGE_TIMEOUT_MS'), issues),
  };

  if (issues.length > 0) throw new ConfigError(issues);
  return result;
}
