import { type BaseEnv, parseBaseEnv, type LogLevel } from './base.env.js';
import { ConfigError, type ConfigIssue } from './errors.js';

export interface ApiEnv extends BaseEnv {
  port: number;
  host: string;
  corsAllowedOrigins: readonly string[];
  publicAppUrl: string | null;
}

function readCsv(env: NodeJS.ProcessEnv, key: string): string[] | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const parts = v
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length === 0 ? undefined : parts;
}

function parsePort(raw: string | undefined, issues: ConfigIssue[]): number {
  if (raw === undefined) return 4000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    issues.push({ key: 'API_PORT', reason: 'must be an integer in 1..65535' });
    return 0;
  }
  return n;
}

function parseHost(raw: string | undefined): string {
  return raw ?? '127.0.0.1';
}

function parsePublicAppUrl(raw: string | undefined, appEnv: string): string | null {
  if (raw !== undefined && raw.length > 0) return raw;
  if (appEnv === 'production') return null;
  return 'http://localhost:3000';
}

export function parseApiEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  const base = parseBaseEnv(env);
  const issues: ConfigIssue[] = [];

  const port = parsePort(env['API_PORT'], issues);
  const host = parseHost(env['API_HOST']);
  const corsOrigins = readCsv(env, 'CORS_ALLOWED_ORIGINS') ?? [];

  if (corsOrigins.some((o) => o === '*')) {
    issues.push({ key: 'CORS_ALLOWED_ORIGINS', reason: 'wildcard "*" is not allowed' });
  }

  const publicAppUrl = parsePublicAppUrl(env['PUBLIC_APP_URL'], base.appEnv);
  if (base.appEnv === 'production' && publicAppUrl === null) {
    issues.push({ key: 'PUBLIC_APP_URL', reason: 'required when APP_ENV=production' });
  }

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    ...base,
    port,
    host,
    corsAllowedOrigins: Object.freeze(corsOrigins),
    publicAppUrl,
  };
}

export type ApiLogLevel = LogLevel;

export const apiEnv = parseApiEnv;
