import { getPool, type Database } from '../../../infrastructure/database/db.js';
import type { PlanType } from './schema.js';

export interface PlanCatalogEntry {
  key: PlanType;
  displayName: string;
  priceAmount: number;
  currency: 'IDR';
  billingPeriod: 'monthly' | null;
  tokenMonthlyLimit: number | null;
  features: unknown[];
  active: boolean;
  revision: number;
  updatedAt: string;
  updatedBy: string | null;
}

type CatalogRow = {
  key: PlanType;
  display_name: string;
  price_amount: number;
  currency: 'IDR';
  billing_period: 'monthly' | null;
  token_monthly_limit: string | null;
  features: unknown[];
  active: boolean;
  revision: number;
  updated_at: Date;
  updated_by: string | null;
};

export function mapCatalogRow(row: CatalogRow): PlanCatalogEntry {
  return {
    key: row.key,
    displayName: row.display_name,
    priceAmount: row.price_amount,
    currency: row.currency,
    billingPeriod: row.billing_period,
    tokenMonthlyLimit: row.token_monthly_limit === null ? null : Number(row.token_monthly_limit),
    features: row.features,
    active: row.active,
    revision: row.revision,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  };
}

export class PlanCatalogRepository {
  constructor(private readonly db: Database) {}

  async list(activeOnly = false): Promise<PlanCatalogEntry[]> {
    const pool = getPool(this.db);
    if (!pool) return [];
    const result = await pool.query<CatalogRow>(
      `SELECT key,display_name,price_amount,currency,billing_period,token_monthly_limit,
              features,active,revision,updated_at,updated_by
       FROM plan_catalog ${activeOnly ? 'WHERE active=true' : ''}
       ORDER BY CASE key WHEN 'free' THEN 0 ELSE 1 END`,
    );
    return result.rows.map(mapCatalogRow);
  }

  async find(key: PlanType): Promise<PlanCatalogEntry | null> {
    const pool = getPool(this.db);
    if (!pool) return null;
    const result = await pool.query<CatalogRow>(
      `SELECT key,display_name,price_amount,currency,billing_period,token_monthly_limit,
              features,active,revision,updated_at,updated_by FROM plan_catalog WHERE key=$1`,
      [key],
    );
    return result.rows[0] ? mapCatalogRow(result.rows[0]) : null;
  }
}
