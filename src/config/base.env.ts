import { ConfigError, type ConfigIssue } from './errors.js';

export const NODE_ENV_VALUES = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENV_VALUES)[number];

export const APP_ENV_VALUES = ['local', 'test', 'preview', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENV_VALUES)[number];

export const LOG_LEVEL_VALUES = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;
export type LogLevel = (typeof LOG_LEVEL_VALUES)[number];

export interface BaseEnv {
  nodeEnv: NodeEnv;
  appEnv: AppEnv;
  serviceName: string;
  serviceVersion: string;
  logLevel: LogLevel;
}

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseNodeEnv(raw: string | undefined, issues: ConfigIssue[]): NodeEnv {
  const fallback: NodeEnv = 'development';
  if (raw === undefined) return fallback;
  if ((NODE_ENV_VALUES as readonly string[]).includes(raw)) return raw as NodeEnv;
  issues.push({ key: 'NODE_ENV', reason: `must be one of ${NODE_ENV_VALUES.join('|')}` });
  return fallback;
}

function parseAppEnv(raw: string | undefined, issues: ConfigIssue[]): AppEnv {
  const fallback: AppEnv = 'local';
  if (raw === undefined) return fallback;
  if ((APP_ENV_VALUES as readonly string[]).includes(raw)) return raw as AppEnv;
  issues.push({ key: 'APP_ENV', reason: `must be one of ${APP_ENV_VALUES.join('|')}` });
  return fallback;
}

function parseLogLevel(raw: string | undefined, issues: ConfigIssue[]): LogLevel {
  const fallback: LogLevel = 'info';
  if (raw === undefined) return fallback;
  if ((LOG_LEVEL_VALUES as readonly string[]).includes(raw)) return raw as LogLevel;
  issues.push({ key: 'LOG_LEVEL', reason: `must be one of ${LOG_LEVEL_VALUES.join('|')}` });
  return fallback;
}

export function parseBaseEnv(env: NodeJS.ProcessEnv = process.env): BaseEnv {
  const issues: ConfigIssue[] = [];

  const nodeEnv = parseNodeEnv(readString(env, 'NODE_ENV'), issues);
  const appEnv = parseAppEnv(readString(env, 'APP_ENV'), issues);

  const serviceName = readString(env, 'SERVICE_NAME') ?? 'lembar-backend';
  const serviceVersion = readString(env, 'SERVICE_VERSION') ?? '0.0.0-dev';
  const logLevel = parseLogLevel(readString(env, 'LOG_LEVEL'), issues);

  if (issues.length > 0) throw new ConfigError(issues);

  return { nodeEnv, appEnv, serviceName, serviceVersion, logLevel };
}

export const baseEnv = parseBaseEnv;
