-- B6-02: Payment integration
-- payment_orders: idempotent order tracking with state machine
-- payment_events: immutable audit log

CREATE TABLE IF NOT EXISTS payment_orders (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT        NOT NULL,
  workspace_id      TEXT        NOT NULL,
  idempotency_key   TEXT        NOT NULL,
  external_order_id TEXT,
  from_plan         TEXT        NOT NULL DEFAULT 'free',
  to_plan           TEXT        NOT NULL,
  amount_cents      INTEGER     NOT NULL,
  currency          TEXT        NOT NULL DEFAULT 'IDR',
  status            TEXT        NOT NULL DEFAULT 'pending',
  gateway_payload   JSONB,
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_orders_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT payment_orders_status_check
    CHECK (status IN ('pending','paid','failed','cancelled','refunded')),
  CONSTRAINT payment_orders_plan_check
    CHECK (from_plan IN ('free','pro') AND to_plan IN ('free','pro')),
  CONSTRAINT payment_orders_amount_non_negative
    CHECK (amount_cents >= 0)
);

CREATE INDEX IF NOT EXISTS payment_orders_workspace_idx
  ON payment_orders (tenant_id, workspace_id);

CREATE INDEX IF NOT EXISTS payment_orders_external_order_idx
  ON payment_orders (external_order_id);

CREATE TABLE IF NOT EXISTS payment_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID        NOT NULL,
  tenant_id     TEXT        NOT NULL,
  workspace_id  TEXT        NOT NULL,
  event_type    TEXT        NOT NULL,
  payload       JSONB       NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_events_event_type_check
    CHECK (event_type IN (
      'order_created','order_paid','order_failed','order_cancelled',
      'order_refunded','webhook_received','plan_upgraded','plan_downgraded'
    ))
);

CREATE INDEX IF NOT EXISTS payment_events_order_idx
  ON payment_events (order_id);

CREATE INDEX IF NOT EXISTS payment_events_workspace_idx
  ON payment_events (tenant_id, workspace_id);
