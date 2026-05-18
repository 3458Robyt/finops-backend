CREATE TYPE "AgentInstructionProfileStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED', 'REJECTED');

CREATE TYPE "TenantAgentRuleStatus" AS ENUM ('ACTIVE', 'DISABLED');

CREATE TYPE "AiContextOperation" AS ENUM ('CHAT', 'RECOMMENDATION', 'EXECUTION_PLAN', 'AUDIT', 'LEARNING');

CREATE TYPE "ContextBuildRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED');

ALTER TABLE "agent_knowledge_nodes"
ADD COLUMN "dedupe_key" TEXT;

ALTER TABLE "agent_knowledge_edges"
ADD COLUMN "dedupe_key" TEXT;

CREATE UNIQUE INDEX "agent_knowledge_nodes_tenant_id_dedupe_key_key"
ON "agent_knowledge_nodes"("tenant_id", "dedupe_key");

CREATE UNIQUE INDEX "agent_knowledge_edges_tenant_id_dedupe_key_key"
ON "agent_knowledge_edges"("tenant_id", "dedupe_key");

CREATE TABLE "agent_instruction_profiles" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "AgentInstructionProfileStatus" NOT NULL DEFAULT 'DRAFT',
    "structured_rules" JSONB NOT NULL,
    "freeform_notes" TEXT,
    "validation_report" JSONB,
    "activated_at" TIMESTAMPTZ(6),
    "created_by_user_id" TEXT NOT NULL,
    "activated_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_instruction_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_instruction_profiles_version_key"
ON "agent_instruction_profiles"("version");

CREATE INDEX "agent_instruction_profiles_status_version_idx"
ON "agent_instruction_profiles"("status", "version");

CREATE TABLE "tenant_agent_rules" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "rule_text" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "status" "TenantAgentRuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "disabled_at" TIMESTAMPTZ(6),
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_agent_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tenant_agent_rules_tenant_id_status_priority_idx"
ON "tenant_agent_rules"("tenant_id", "status", "priority");

CREATE TABLE "agent_instruction_audit_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_instruction_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_instruction_audit_events_tenant_id_created_at_idx"
ON "agent_instruction_audit_events"("tenant_id", "created_at");

CREATE INDEX "agent_instruction_audit_events_actor_user_id_created_at_idx"
ON "agent_instruction_audit_events"("actor_user_id", "created_at");

CREATE INDEX "agent_instruction_audit_events_entity_type_entity_id_idx"
ON "agent_instruction_audit_events"("entity_type", "entity_id");

CREATE TABLE "context_summary_cache" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "artifact_type" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "provider" TEXT,
    "cloud_account_id" TEXT,
    "service_name" TEXT,
    "resource_id" TEXT,
    "period_start" TIMESTAMPTZ(6),
    "period_end" TIMESTAMPTZ(6),
    "source_hash" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "facts" JSONB,
    "evidence_refs" JSONB,
    "token_estimate" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "context_summary_cache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "context_summary_cache_tenant_id_artifact_type_scope_key_source_hash_key"
ON "context_summary_cache"("tenant_id", "artifact_type", "scope_key", "source_hash");

CREATE INDEX "context_summary_cache_tenant_id_artifact_type_updated_at_idx"
ON "context_summary_cache"("tenant_id", "artifact_type", "updated_at");

CREATE INDEX "context_summary_cache_tenant_id_provider_service_name_idx"
ON "context_summary_cache"("tenant_id", "provider", "service_name");

CREATE INDEX "context_summary_cache_tenant_id_resource_id_idx"
ON "context_summary_cache"("tenant_id", "resource_id");

CREATE TABLE "ai_context_traces" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT,
    "operation" "AiContextOperation" NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "profile_version" INTEGER,
    "prompt_token_estimate" INTEGER NOT NULL DEFAULT 0,
    "response_token_estimate" INTEGER,
    "latency_ms" INTEGER,
    "artifact_ids" JSONB,
    "memory_ids" JSONB,
    "knowledge_node_ids" JSONB,
    "tenant_rule_ids" JSONB,
    "conflicts" JSONB,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_context_traces_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_context_traces_tenant_id_operation_created_at_idx"
ON "ai_context_traces"("tenant_id", "operation", "created_at");

CREATE INDEX "ai_context_traces_tenant_id_status_created_at_idx"
ON "ai_context_traces"("tenant_id", "status", "created_at");

CREATE INDEX "ai_context_traces_expires_at_idx"
ON "ai_context_traces"("expires_at");

CREATE TABLE "context_build_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_type" TEXT NOT NULL,
    "status" "ContextBuildRunStatus" NOT NULL DEFAULT 'PENDING',
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "error_message" TEXT,
    "metadata" JSONB,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "context_build_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "context_build_runs_tenant_id_status_created_at_idx"
ON "context_build_runs"("tenant_id", "status", "created_at");

ALTER TABLE "agent_instruction_profiles"
ADD CONSTRAINT "agent_instruction_profiles_created_by_user_id_fkey"
FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agent_instruction_profiles"
ADD CONSTRAINT "agent_instruction_profiles_activated_by_user_id_fkey"
FOREIGN KEY ("activated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tenant_agent_rules"
ADD CONSTRAINT "tenant_agent_rules_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tenant_agent_rules"
ADD CONSTRAINT "tenant_agent_rules_created_by_user_id_fkey"
FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agent_instruction_audit_events"
ADD CONSTRAINT "agent_instruction_audit_events_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_instruction_audit_events"
ADD CONSTRAINT "agent_instruction_audit_events_actor_user_id_fkey"
FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "context_summary_cache"
ADD CONSTRAINT "context_summary_cache_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_context_traces"
ADD CONSTRAINT "ai_context_traces_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_context_traces"
ADD CONSTRAINT "ai_context_traces_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "context_build_runs"
ADD CONSTRAINT "context_build_runs_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "context_build_runs"
ADD CONSTRAINT "context_build_runs_created_by_user_id_fkey"
FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
