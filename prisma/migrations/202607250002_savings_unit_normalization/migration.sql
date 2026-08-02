ALTER TABLE "recommendation_savings_measurements"
  ADD COLUMN "baseline_unit_cost" DECIMAL(18,9),
  ADD COLUMN "observation_unit_cost" DECIMAL(18,9),
  ADD COLUMN "quantity_change_ratio" DECIMAL(8,6),
  ADD COLUMN "calculation_method" VARCHAR(24) NOT NULL DEFAULT 'COST_DELTA';
