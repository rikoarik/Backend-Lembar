CREATE TABLE plan_catalog (
  key text PRIMARY KEY CHECK (key IN ('free', 'pro')),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  price_amount integer NOT NULL CHECK (price_amount >= 0),
  currency text NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  billing_period text CHECK (billing_period IN ('monthly') OR billing_period IS NULL),
  token_monthly_limit bigint CHECK (token_monthly_limit >= 0 OR token_monthly_limit IS NULL),
  features jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(features) = 'array'),
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

INSERT INTO plan_catalog
  (key, display_name, price_amount, billing_period, token_monthly_limit, features)
VALUES
  ('free', 'Free', 0, NULL, 60000, '[]'::jsonb),
  ('pro', 'Pro', 49000, 'monthly', NULL, '[]'::jsonb);
