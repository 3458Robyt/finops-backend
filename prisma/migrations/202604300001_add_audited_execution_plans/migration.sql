-- CreateEnum
CREATE TYPE "AiAuditVerdict" AS ENUM ('APPROVED', 'REJECTED', 'NEEDS_REVISION');

-- CreateTable
CREATE TABLE "recommendation_execution_plans" (
    "id" TEXT NOT NULL,
    "recommendation_id" TEXT NOT NULL,
    "generated_by_user_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "auditor_model" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "audit_report" JSONB NOT NULL,
    "audit_verdict" "AiAuditVerdict" NOT NULL,
    "audit_score" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_execution_plans_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "recommendation_decisions"
ADD COLUMN "execution_plan_id" TEXT;

-- CreateIndex
CREATE INDEX "recommendation_execution_plans_recommendation_id_created_at_idx"
ON "recommendation_execution_plans"("recommendation_id", "created_at");

-- CreateIndex
CREATE INDEX "recommendation_execution_plans_generated_by_user_id_created_at_idx"
ON "recommendation_execution_plans"("generated_by_user_id", "created_at");

-- CreateIndex
CREATE INDEX "recommendation_decisions_execution_plan_id_created_at_idx"
ON "recommendation_decisions"("execution_plan_id", "created_at");

-- AddForeignKey
ALTER TABLE "recommendation_execution_plans"
ADD CONSTRAINT "recommendation_execution_plans_recommendation_id_fkey"
FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_execution_plans"
ADD CONSTRAINT "recommendation_execution_plans_generated_by_user_id_fkey"
FOREIGN KEY ("generated_by_user_id") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_decisions"
ADD CONSTRAINT "recommendation_decisions_execution_plan_id_fkey"
FOREIGN KEY ("execution_plan_id") REFERENCES "recommendation_execution_plans"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
