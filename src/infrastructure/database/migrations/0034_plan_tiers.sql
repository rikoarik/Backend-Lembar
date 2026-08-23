-- 0034_plan_tiers.sql
--
-- Introduce the 'plus' plan tier and make token limits finite on every tier.
-- Catalog after this migration:
--   free → 30.000 tokens/month  (Rp0)
--   pro  → 250.000 tokens/month (Rp49.000/month)
--   plus → 300.000 tokens/month (Rp149.000/month)
--
-- No unlimited tier remains: PRD states "Tidak menjanjikan unlimited AI".
-- Existing 'pro' workspaces keep their plan row; they simply gain a finite
-- monthly token limit going forward.
--
-- Rollback (forward-fix): re-run the inverse below only if no 'plus' rows
-- exist in workspace_plans / payment_orders:
--   UPDATE plan_catalog SET token_monthly_limit = NULL WHERE key = 'pro';
--   DELETE FROM plan_catalog WHERE key = 'plus';
--   restore previous CHECK constraints without 'plus'.

-- ── plan_catalog ─────────────────────────────────────────────────────────────
ALTER TABLE plan_catalog DROP CONSTRAINT plan_catalog_key_check;
ALTER TABLE plan_catalog
  ADD CONSTRAINT plan_catalog_key_check CHECK (key IN ('free', 'pro', 'plus'));

UPDATE plan_catalog SET token_monthly_limit = 30000, updated_at = now()
WHERE key = 'free';

UPDATE plan_catalog
SET token_monthly_limit = 250000,
    price_amount = 49000,
    billing_period = 'monthly',
    updated_at = now()
WHERE key = 'pro';

INSERT INTO plan_catalog
  (key, display_name, price_amount, currency, billing_period, token_monthly_limit, features)
VALUES
  ('plus', 'Plus', 149000, 'IDR', 'monthly', 300000, '[]'::jsonb)
ON CONFLICT (key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  price_amount = EXCLUDED.price_amount,
  billing_period = EXCLUDED.billing_period,
  token_monthly_limit = EXCLUDED.token_monthly_limit,
  active = true,
  updated_at = now();

-- ── workspace_plans ──────────────────────────────────────────────────────────
ALTER TABLE workspace_plans DROP CONSTRAINT workspace_plans_plan_check;
ALTER TABLE workspace_plans
  ADD CONSTRAINT workspace_plans_plan_check CHECK (plan IN ('free', 'pro', 'plus'));

-- ── payment_orders ───────────────────────────────────────────────────────────
ALTER TABLE payment_orders DROP CONSTRAINT payment_orders_plan_check;
ALTER TABLE payment_orders
  ADD CONSTRAINT payment_orders_plan_check
  CHECK (from_plan IN ('free','pro','plus') AND to_plan IN ('free','pro','plus'));
