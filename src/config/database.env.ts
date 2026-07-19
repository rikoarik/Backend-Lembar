import { ConfigError, type ConfigIssue } from './errors.js';

export const DATABASE_SSL_MODES = ['disable', 'require'] as const;
export type DatabaseSslMode = (typeof DATABASE_SSL_MODES)[number];

export interface DatabaseEnv {
  required: boolean;
  url: string | null;
  poolMax: number;
  sslMode: DatabaseSslMode;
}

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseBoolean(raw: string | undefined, issues: ConfigIssue[]): boolean {
  if (raw === undefined) return false;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  issues.push({ key: 'DATABASE_REQUIRED', reason: 'must be true|false|1|0' });
  return false;
}

function parsePoolMax(raw: string | undefined, issues: ConfigIssue[]): number {
  const fallback = 10;
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    issues.push({ key: 'DATABASE_POOL_MAX', reason: 'must be an integer in 1..50' });
    return fallback;
  }
  return n;
}

function parseSslMode(raw: string | undefined, issues: ConfigIssue[]): DatabaseSslMode {
  const fallback: DatabaseSslMode = 'disable';
  if (raw === undefined) return fallback;
  if ((DATABASE_SSL_MODES as readonly string[]).includes(raw)) return raw as DatabaseSslMode;
  issues.push({
    key: 'DATABASE_SSL_MODE',
    reason: `must be one of ${DATABASE_SSL_MODES.join('|')}`,
  });
  return fallback;
}

export function parseDatabaseEnv(env: NodeJS.ProcessEnv = process.env): DatabaseEnv {
  const issues: ConfigIssue[] = [];

  const required = parseBoolean(readString(env, 'DATABASE_REQUIRED'), issues);
  const url = readString(env, 'DATABASE_URL') ?? null;
  const poolMax = parsePoolMax(readString(env, 'DATABASE_POOL_MAX'), issues);
  const sslMode = parseSslMode(readString(env, 'DATABASE_SSL_MODE'), issues);

  if (required && url === null) {
    issues.push({ key: 'DATABASE_URL', reason: 'required when DATABASE_REQUIRED=true' });
  }

  if (issues.length > 0) throw new ConfigError(issues);

  return { required, url, poolMax, sslMode };
}

export const databaseEnv = parseDatabaseEnv;
