ALTER TABLE "cost_allocation_rules"
  ADD COLUMN IF NOT EXISTS "last_previewed_hash" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "last_previewed_at" TIMESTAMPTZ(6);
