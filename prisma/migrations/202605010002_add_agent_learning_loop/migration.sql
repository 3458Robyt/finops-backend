-- CreateEnum
CREATE TYPE "RecommendationFeedbackReason" AS ENUM (
  'APPROVED_HIGH_CONFIDENCE',
  'APPROVED_LOW_RISK_QUICK_WIN',
  'REJECTED_INSUFFICIENT_EVIDENCE',
  'REJECTED_SAVINGS_UNREALISTIC',
  'REJECTED_OPERATIONAL_RISK',
  'REJECTED_BUSINESS_EXCEPTION',
  'REJECTED_ALREADY_HANDLED',
  'REJECTED_WRONG_SCOPE',
  'REJECTED_NOT_ACTIONABLE'
);

-- CreateEnum
CREATE TYPE "AgentLearningStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "AgentMemoryScope" AS ENUM ('LOCAL', 'GLOBAL');

-- CreateEnum
CREATE TYPE "AgentMemoryType" AS ENUM (
  'RULE',
  'LESSON',
  'APPROVAL_PATTERN',
  'REJECTION_PATTERN',
  'DECISION_PATTERN'
);

-- AlterTable
ALTER TABLE "recommendation_decisions"
ADD COLUMN "reason_code" "RecommendationFeedbackReason",
ADD COLUMN "learning_processed_at" TIMESTAMPTZ(6),
ADD COLUMN "learning_status" "AgentLearningStatus";

-- CreateTable
CREATE TABLE "agent_learning_events" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "recommendation_id" TEXT NOT NULL,
  "decision_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "decision" "RecommendationDecisionType" NOT NULL,
  "reason_code" "RecommendationFeedbackReason" NOT NULL,
  "reason" TEXT,
  "recommendation_type" TEXT NOT NULL,
  "cloud_account_id" TEXT NOT NULL,
  "severity" "RecommendationSeverity" NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "evidence_summary" TEXT NOT NULL,
  "status" "AgentLearningStatus" NOT NULL DEFAULT 'PENDING',
  "audit_verdict" "AiAuditVerdict",
  "audit_score" INTEGER,
  "audit_report" JSONB,
  "error_message" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_learning_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_memory" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT,
  "scope" "AgentMemoryScope" NOT NULL,
  "memory_type" "AgentMemoryType" NOT NULL,
  "content" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "source_learning_event_id" TEXT,
  "metadata" JSONB,
  "audit_verdict" "AiAuditVerdict" NOT NULL,
  "audit_score" INTEGER NOT NULL,
  "audit_report" JSONB NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_knowledge_nodes" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT,
  "scope" "AgentMemoryScope" NOT NULL,
  "node_type" TEXT NOT NULL,
  "external_id" TEXT,
  "label" TEXT NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_knowledge_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_knowledge_edges" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT,
  "source_node_id" TEXT NOT NULL,
  "target_node_id" TEXT NOT NULL,
  "relation_type" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  "metadata" JSONB,
  "source_learning_event_id" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_knowledge_edges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recommendation_decisions_reason_code_created_at_idx"
ON "recommendation_decisions"("reason_code", "created_at");

-- CreateIndex
CREATE INDEX "recommendation_decisions_learning_status_created_at_idx"
ON "recommendation_decisions"("learning_status", "created_at");

-- CreateIndex
CREATE INDEX "agent_learning_events_tenant_id_status_created_at_idx"
ON "agent_learning_events"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "agent_learning_events_recommendation_id_created_at_idx"
ON "agent_learning_events"("recommendation_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_learning_events_decision_id_idx"
ON "agent_learning_events"("decision_id");

-- CreateIndex
CREATE INDEX "agent_learning_events_reason_code_recommendation_type_idx"
ON "agent_learning_events"("reason_code", "recommendation_type");

-- CreateIndex
CREATE INDEX "agent_learning_events_fts_idx"
ON "agent_learning_events"
USING GIN (to_tsvector('spanish', coalesce("title", '') || ' ' || coalesce("description", '') || ' ' || coalesce("reason", '') || ' ' || coalesce("evidence_summary", '')));

-- CreateIndex
CREATE INDEX "agent_memory_tenant_id_active_created_at_idx"
ON "agent_memory"("tenant_id", "active", "created_at");

-- CreateIndex
CREATE INDEX "agent_memory_scope_active_created_at_idx"
ON "agent_memory"("scope", "active", "created_at");

-- CreateIndex
CREATE INDEX "agent_memory_memory_type_active_idx"
ON "agent_memory"("memory_type", "active");

-- CreateIndex
CREATE INDEX "agent_memory_fingerprint_active_idx"
ON "agent_memory"("fingerprint", "active");

-- CreateIndex
CREATE INDEX "agent_memory_fts_idx"
ON "agent_memory"
USING GIN (to_tsvector('spanish', coalesce("content", '')));

-- CreateIndex
CREATE INDEX "agent_knowledge_nodes_tenant_id_node_type_idx"
ON "agent_knowledge_nodes"("tenant_id", "node_type");

-- CreateIndex
CREATE INDEX "agent_knowledge_nodes_scope_node_type_idx"
ON "agent_knowledge_nodes"("scope", "node_type");

-- CreateIndex
CREATE INDEX "agent_knowledge_nodes_external_id_idx"
ON "agent_knowledge_nodes"("external_id");

-- CreateIndex
CREATE INDEX "agent_knowledge_edges_tenant_id_relation_type_idx"
ON "agent_knowledge_edges"("tenant_id", "relation_type");

-- CreateIndex
CREATE INDEX "agent_knowledge_edges_source_node_id_relation_type_idx"
ON "agent_knowledge_edges"("source_node_id", "relation_type");

-- CreateIndex
CREATE INDEX "agent_knowledge_edges_target_node_id_relation_type_idx"
ON "agent_knowledge_edges"("target_node_id", "relation_type");

-- AddForeignKey
ALTER TABLE "agent_learning_events"
ADD CONSTRAINT "agent_learning_events_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_learning_events"
ADD CONSTRAINT "agent_learning_events_recommendation_id_fkey"
FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_learning_events"
ADD CONSTRAINT "agent_learning_events_decision_id_fkey"
FOREIGN KEY ("decision_id") REFERENCES "recommendation_decisions"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_learning_events"
ADD CONSTRAINT "agent_learning_events_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_memory"
ADD CONSTRAINT "agent_memory_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_memory"
ADD CONSTRAINT "agent_memory_source_learning_event_id_fkey"
FOREIGN KEY ("source_learning_event_id") REFERENCES "agent_learning_events"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_knowledge_nodes"
ADD CONSTRAINT "agent_knowledge_nodes_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_knowledge_edges"
ADD CONSTRAINT "agent_knowledge_edges_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_knowledge_edges"
ADD CONSTRAINT "agent_knowledge_edges_source_node_id_fkey"
FOREIGN KEY ("source_node_id") REFERENCES "agent_knowledge_nodes"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_knowledge_edges"
ADD CONSTRAINT "agent_knowledge_edges_target_node_id_fkey"
FOREIGN KEY ("target_node_id") REFERENCES "agent_knowledge_nodes"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_knowledge_edges"
ADD CONSTRAINT "agent_knowledge_edges_source_learning_event_id_fkey"
FOREIGN KEY ("source_learning_event_id") REFERENCES "agent_learning_events"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
