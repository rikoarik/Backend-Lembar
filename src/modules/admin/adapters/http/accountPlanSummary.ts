export type AccountPlanSummaryRow = {
  plan_key: string | null;
  token_used_this_month?: string | number | null;
  token_monthly_limit?: string | number | null;
};

export type AccountPlanSummary = {
  planKey: string;
  tokenUsedThisMonth: number;
  tokenMonthlyLimit: number | null;
};

function numberOrZero(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Converts the tenant-scoped workspace-plan join into the intentionally small
 * admin account detail payload. A missing join is represented as null so the
 * caller never presents fallback usage as measured usage.
 */
export function mapWorkspacePlanSummary(row: AccountPlanSummaryRow): AccountPlanSummary | null {
  if (!row.plan_key) return null;

  return {
    planKey: row.plan_key,
    tokenUsedThisMonth: numberOrZero(row.token_used_this_month),
    tokenMonthlyLimit:
      row.token_monthly_limit === null || row.token_monthly_limit === undefined
        ? null
        : numberOrZero(row.token_monthly_limit),
  };
}
