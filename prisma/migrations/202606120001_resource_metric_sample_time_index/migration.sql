CREATE INDEX IF NOT EXISTS "resource_metric_samples_tenant_id_sampled_at_idx"
ON "resource_metric_samples" ("tenant_id", "sampled_at");
