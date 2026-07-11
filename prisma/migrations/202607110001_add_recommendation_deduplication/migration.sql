ALTER TABLE "recommendations"
  ADD COLUMN "deduplication_key" TEXT;

CREATE UNIQUE INDEX "recommendations_tenant_id_deduplication_key_key"
  ON "recommendations"("tenant_id", "deduplication_key");
