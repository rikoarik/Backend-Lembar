-- Migration: 0013_workspace_plans
-- Task: B6-01 — Entitlement & quota
-- Adds workspace_plans table tracking plan type and monthly generation usage.
-- Rollback: DROP TABLE workspace_plans;

CREATE TABLE IF NOT EXISTS "workspace_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "workspace_id" text NOT NULL,
  "plan" text NOT NULL DEFAULT 'free',
  "generations_used_this_month" integer NOT NULL DEFAULT 0,
  "billing_cycle_started_at" timestamptz NOT NULL DEFAULT now(),
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_plans_plan_check" CHECK ("plan" in ('free','pro')),
  CONSTRAINT "workspace_plans_usage_non_negative" CHECK ("generations_used_this_month" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_plans_workspace_unique"
  ON "workspace_plans" ("tenant_id", "workspace_id");

CREATE INDEX IF NOT EXISTS "workspace_plans_tenant_idx"
  ON "workspace_plans" ("tenant_id");
