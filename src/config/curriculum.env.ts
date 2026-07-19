import { ConfigError, type ConfigIssue } from './errors.js';

export interface CurriculumEnv {
  bearerToken: string | null;
  sourceRightsAllowlist: readonly string[];
}

const DEFAULT_ALLOWLIST = ['license:internal', 'license:cc-by', 'license:cc-by-sa'];

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseAllowlist(raw: string | undefined, issues: ConfigIssue[]): readonly string[] {
  const values = (raw ?? DEFAULT_ALLOWLIST.join(','))
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (values.length === 0) {
    issues.push({
      key: 'CURRICULUM_SOURCE_RIGHTS_ALLOWLIST',
      reason: 'must contain at least one license',
    });
    return DEFAULT_ALLOWLIST;
  }
  return Object.freeze(values);
}

export function parseCurriculumEnv(env: NodeJS.ProcessEnv = process.env): CurriculumEnv {
  const issues: ConfigIssue[] = [];
  const bearerToken = readString(env, 'CURRICULUM_WRITE_TOKEN') ?? null;
  const sourceRightsAllowlist = parseAllowlist(
    readString(env, 'CURRICULUM_SOURCE_RIGHTS_ALLOWLIST'),
    issues,
  );
  if (issues.length > 0) throw new ConfigError(issues);
  return { bearerToken, sourceRightsAllowlist };
}

export const curriculumEnv = parseCurriculumEnv;
