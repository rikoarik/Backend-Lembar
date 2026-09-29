import { ConfigError, type ConfigIssue } from './errors.js';
import { DEFAULT_SOURCE_UPLOAD_MAX_BYTES } from '../modules/uploads/policy/UploadPolicies.js';

/**
 * BUG-18 — `SOURCE_UPLOAD_MAX_BYTES` was documented (`.env.example`) but never
 * parsed, so the intake route kept Fastify's 1 MiB default body limit while the
 * handler advertised 50 MiB. The value now drives the request body limit, the
 * service cap, and the `maxBytes` echoed on every success response.
 */
export const SOURCE_UPLOAD_MAX_BYTES_FLOOR = 1_024;
export const SOURCE_UPLOAD_MAX_BYTES_CEILING = 512 * 1_024 * 1_024;

export interface UploadsEnv {
  maxBytes: number;
}

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function parseUploadsEnv(env: NodeJS.ProcessEnv = process.env): UploadsEnv {
  const issues: ConfigIssue[] = [];
  const raw = readString(env, 'SOURCE_UPLOAD_MAX_BYTES');
  if (raw === undefined) return { maxBytes: DEFAULT_SOURCE_UPLOAD_MAX_BYTES };

  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed < SOURCE_UPLOAD_MAX_BYTES_FLOOR ||
    parsed > SOURCE_UPLOAD_MAX_BYTES_CEILING
  ) {
    issues.push({
      key: 'SOURCE_UPLOAD_MAX_BYTES',
      reason: `must be an integer in ${SOURCE_UPLOAD_MAX_BYTES_FLOOR}..${SOURCE_UPLOAD_MAX_BYTES_CEILING}`,
    });
    throw new ConfigError(issues);
  }

  return { maxBytes: parsed };
}

export const uploadsEnv = parseUploadsEnv;

/**
 * Tolerant variant for boot-time wiring: a malformed upload cap must not stop
 * the API from starting, so fall back to the documented default.
 */
export function resolveSourceUploadMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  try {
    return parseUploadsEnv(env).maxBytes;
  } catch {
    return DEFAULT_SOURCE_UPLOAD_MAX_BYTES;
  }
}
