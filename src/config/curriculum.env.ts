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

/**
 * Boot-time guard for the curriculum write surface (AUDIT-2 / t_02e3d131).
 *
 * `parseCurriculumEnv` deliberately keeps `bearerToken` nullable so the request
 * guard can answer a clean 401 in local/test; this function is the loud
 * production counterpart. The curriculum module is a stub-protected internal
 * write surface — it must never be mounted in production without a configured
 * credential, because an unset token used to mean "accept any Bearer token"
 * and performed real, committed writes.
 *
 * The thrown `ConfigError` names the key only, never a value.
 */
export function assertCurriculumWriteTokenConfigured(env: NodeJS.ProcessEnv = process.env): void {
  if (readString(env, 'APP_ENV') !== 'production') return;
  if (readString(env, 'CURRICULUM_WRITE_TOKEN') !== undefined) return;
  throw new ConfigError([
    {
      key: 'CURRICULUM_WRITE_TOKEN',
      reason:
        'required when APP_ENV=production and the curriculum module is mounted; refusing to expose curriculum write endpoints without a configured bearer',
    },
  ]);
}

export const curriculumEnv = parseCurriculumEnv;
