-- Tenant reporting currency and auditable historical FX reference data.
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "reporting_currency" VARCHAR(3) NOT NULL DEFAULT 'USD';

-- Preserve the existing dominant billing currency as the initial tenant default.
UPDATE "tenants" AS t
SET "reporting_currency" = COALESCE((
  SELECT cm."billing_currency"
  FROM "cost_metrics" AS cm
  WHERE cm."tenant_id" = t."id"
  GROUP BY cm."billing_currency"
  ORDER BY COUNT(*) DESC, cm."billing_currency" ASC
  LIMIT 1
), 'USD');

CREATE TABLE IF NOT EXISTS "fx_rates" (
  "id" TEXT NOT NULL,
  "base_currency" VARCHAR(3) NOT NULL,
  "quote_currency" VARCHAR(3) NOT NULL,
  "rate" DECIMAL(24,12) NOT NULL,
  "valid_from" DATE NOT NULL,
  "valid_to" DATE,
  "source" TEXT NOT NULL,
  "source_url" TEXT,
  "retrieved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "fx_rates_pair_date_source_key"
  ON "fx_rates" ("base_currency", "quote_currency", "valid_from", "source");

CREATE INDEX IF NOT EXISTS "fx_rates_lookup_idx"
  ON "fx_rates" ("base_currency", "quote_currency", "valid_from", "valid_to");

CREATE INDEX IF NOT EXISTS "cost_metrics_tenant_currency_period_idx"
  ON "cost_metrics" ("tenant_id", "billing_currency", "charge_period_start");
