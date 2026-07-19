export interface ConfigIssue {
  key: string;
  reason: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(formatConfigError(issues));
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function formatConfigError(issues: ConfigIssue[]): string {
  return issues.map((issue) => `${issue.key}: ${issue.reason}`).join('; ');
}
