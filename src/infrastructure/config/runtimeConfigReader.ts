import { validateRuntimeConfig } from './runtimeConfig.js';
import type { ProcessRole, RuntimeConfig, SameSitePolicy, TrustProxy } from './runtimeConfigTypes.js';

/**
 * Reads environment variables once at the composition boundary and exposes a
 * typed, immutable view to the rest of the process. Tests may pass an explicit
 * environment object without mutating the process environment.
 */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  validateRuntimeConfig(env);

  const nodeEnv = env['NODE_ENV'] ?? 'development';
  const processRole = readProcessRole(env['APP_PROCESS_ROLE']);
  const corsOrigins = readCsv(env['CORS_ORIGIN'], ['http://localhost:5173']);

  return {
    environment: {
      nodeEnv,
      isProduction: nodeEnv === 'production',
      processRole,
    },
    http: {
      port: readPositiveInteger(env['PORT'], 3000),
      corsOrigins,
      bodyLimit: readString(env['HTTP_BODY_LIMIT'], '1mb'),
      trustProxy: readTrustProxy(env['TRUST_PROXY']),
      requestTimeoutMs: readPositiveInteger(env['HTTP_REQUEST_TIMEOUT_MS'], 120_000),
      headersTimeoutMs: readPositiveInteger(env['HTTP_HEADERS_TIMEOUT_MS'], 15_000),
      keepAliveTimeoutMs: readPositiveInteger(env['HTTP_KEEP_ALIVE_TIMEOUT_MS'], 5_000),
      apiRateLimitPerMinute: readPositiveInteger(env['API_RATE_LIMIT_PER_MINUTE'], 600),
      aiRateLimitPerMinute: readPositiveInteger(env['AI_RATE_LIMIT_PER_MINUTE'], 30),
    },
    database: {
      url: readOptionalString(env['DATABASE_URL']),
      runtimeEnforce: readBoolean(env['DB_RUNTIME_ENFORCE'], false),
      runtimeRole: readString(env['DB_RUNTIME_ROLE'], 'finops_runtime'),
      expectedMigration: readOptionalString(env['DB_EXPECTED_MIGRATION']),
    },
    security: {
      jwtSecret: readOptionalString(env['JWT_SECRET']),
      jwtIssuer: readString(env['JWT_ISSUER'], 'finops-backend'),
      jwtAudience: readString(env['JWT_AUDIENCE'], 'finops-app'),
      jwtExpiresInSeconds: readPositiveInteger(env['JWT_EXPIRES_IN_SECONDS'], 900),
      refreshTokenTtlSeconds: readPositiveInteger(env['AUTH_REFRESH_TOKEN_TTL_SECONDS'], 2_592_000),
      cookieSameSite: readSameSite(env['AUTH_COOKIE_SAME_SITE']),
      credentialEncryptionKey: readOptionalString(env['CREDENTIAL_ENCRYPTION_KEY']),
      credentialKeyVersion: readString(env['CREDENTIAL_KEY_VERSION'], 'v1'),
      mfaRequiredForPrivileged: readBoolean(env['MFA_REQUIRED_FOR_PRIVILEGED'], false),
      metricsToken: readOptionalString(env['METRICS_TOKEN']),
      passwordResetUrl: readString(env['PASSWORD_RESET_URL'], 'http://localhost:5173/reset-password'),
      passwordResetTtlSeconds: readPositiveInteger(env['PASSWORD_RESET_TTL_SECONDS'], 900),
    },
    ai: {
      apiKey: readOptionalString(env['AI_API_KEY']),
      baseUrl: readString(env['AI_BASE_URL'], 'https://api.openai.com/v1'),
      model: readString(env['AI_MODEL'], 'gpt-5.4-mini'),
      auditorModel: readString(env['AI_AUDITOR_MODEL'], readString(env['AI_MODEL'], 'gpt-5.4-mini')),
      timeoutMs: readPositiveInteger(env['AI_TIMEOUT_MS'], 60_000),
      maxRetries: readNonNegativeInteger(env['AI_MAX_RETRIES'], 1),
      learningAuditTimeoutMs: readPositiveInteger(env['LEARNING_AUDIT_TIMEOUT_MS'], 15_000),
      ...optionalAiPricing(env),
    },
    cloud: {
      requiredTagKeys: readCsv(env['FINOPS_REQUIRED_TAG_KEYS'], ['environment', 'owner', 'application', 'cost_center']),
    },
    email: {
      enabled: readBoolean(env['EMAIL_ENABLED'], false),
      timeoutMs: readPositiveInteger(env['OUTBOUND_PROVIDER_TIMEOUT_MS'], 15_000),
      host: readOptionalString(env['SMTP_HOST']),
      port: readPositiveInteger(env['SMTP_PORT'], 587),
      secure: readBoolean(env['SMTP_SECURE'], false),
      user: readOptionalString(env['SMTP_USER']),
      password: readOptionalString(env['SMTP_PASSWORD']),
      from: readOptionalString(env['SMTP_FROM'] ?? env['SMTP_USER']),
      fromName: readString(env['SMTP_FROM_NAME'], 'FinOps Inteligente'),
    },
    telegram: {
      enabled: readBoolean(env['TELEGRAM_ENABLED'], false),
      timeoutMs: readPositiveInteger(env['OUTBOUND_PROVIDER_TIMEOUT_MS'], 15_000),
      botToken: readOptionalString(env['TELEGRAM_BOT_TOKEN']),
      botUsername: readOptionalString(env['TELEGRAM_BOT_USERNAME']),
      webhookSecret: readOptionalString(env['TELEGRAM_WEBHOOK_SECRET']),
    },
    workers: {
      ingestion: {
        enabled: readBoolean(env['INGESTION_WORKER_ENABLED'], false),
        id: readOptionalString(env['INGESTION_WORKER_ID']),
        intervalMs: readPositiveInteger(env['INGESTION_WORKER_INTERVAL_MS'], 30_000),
        jobLeaseMs: readPositiveInteger(env['INGESTION_JOB_LEASE_MS'], 300_000),
        jobHeartbeatMs: readPositiveInteger(env['INGESTION_JOB_HEARTBEAT_MS'], 60_000),
      },
      learning: {
        enabled: readBoolean(env['AGENT_LEARNING_WORKER_ENABLED'], false),
        id: readOptionalString(env['AGENT_LEARNING_WORKER_ID']),
        intervalMs: readPositiveInteger(env['AGENT_LEARNING_WORKER_INTERVAL_MS'], 5_000),
        leaseMs: readPositiveInteger(env['AGENT_LEARNING_LEASE_MS'], 60_000),
      },
      recommendationAnalysis: {
        enabled: readBoolean(env['RECOMMENDATION_ANALYSIS_WORKER_ENABLED'], false),
        id: readOptionalString(env['RECOMMENDATION_ANALYSIS_WORKER_ID']),
        intervalMs: readPositiveInteger(env['RECOMMENDATION_ANALYSIS_WORKER_INTERVAL_MS'], 5_000),
        staleAfterMs: readPositiveInteger(env['RECOMMENDATION_ANALYSIS_WORKER_STALE_AFTER_MS'], 30 * 60 * 1000),
      },
    },
    schedulers: {
      message: {
        enabled: readBoolean(env['MESSAGE_SCHEDULER_ENABLED'], false),
        tenantId: readOptionalString(env['MESSAGE_SCHEDULER_TENANT_ID']),
        userId: readOptionalString(env['MESSAGE_SCHEDULER_USER_ID']),
        intervalMinutes: readPositiveInteger(env['MESSAGE_SCHEDULER_INTERVAL_MINUTES'], 1440),
        deliveryBatchSize: readPositiveInteger(env['MESSAGE_SCHEDULER_DELIVERY_BATCH_SIZE'], 50),
        deliveryLeaseMs: readPositiveInteger(env['MESSAGE_SCHEDULER_DELIVERY_LEASE_MS'], 120_000),
        deliveryRetryBackoffMs: readPositiveInteger(env['MESSAGE_SCHEDULER_DELIVERY_RETRY_BACKOFF_MS'], 30_000),
      },
      ingestion: {
        enabled: readBoolean(env['INGESTION_SCHEDULER_ENABLED'], false),
        intervalMs: readPositiveInteger(env['INGESTION_SCHEDULER_INTERVAL_MS'], 300_000),
        inventoryWindowHours: readPositiveInteger(env['INGESTION_SCHEDULER_INVENTORY_WINDOW_HOURS'], 24),
        inventoryCooldownHours: readPositiveInteger(env['INGESTION_SCHEDULER_INVENTORY_COOLDOWN_HOURS'], 24),
        metricWindowMinutes: readPositiveInteger(env['INGESTION_SCHEDULER_METRIC_WINDOW_MINUTES'], 30),
        metricCooldownMinutes: readPositiveInteger(env['INGESTION_SCHEDULER_METRIC_COOLDOWN_MINUTES'], 25),
        billingWindowHours: readPositiveInteger(env['INGESTION_SCHEDULER_BILLING_WINDOW_HOURS'], 24),
        billingCooldownHours: readPositiveInteger(env['INGESTION_SCHEDULER_BILLING_COOLDOWN_HOURS'], 6),
        maxAttempts: readPositiveInteger(env['INGESTION_SCHEDULER_MAX_ATTEMPTS'], 1),
        validationMaxAgeMinutes: readPositiveInteger(env['INGESTION_SCHEDULER_VALIDATION_MAX_AGE_MINUTES'], 1440),
        provider: readOptionalString(env['INGESTION_SCHEDULER_PROVIDER']),
        connectionId: readOptionalString(env['INGESTION_SCHEDULER_CONNECTION_ID']),
      },
      recommendationAnalysis: {
        enabled: readBoolean(env['RECOMMENDATION_ANALYSIS_SCHEDULER_ENABLED'], false),
        intervalMs: readPositiveInteger(env['RECOMMENDATION_ANALYSIS_SCHEDULER_INTERVAL_MS'], 300_000),
        cooldownMinutes: readPositiveInteger(env['RECOMMENDATION_ANALYSIS_SCHEDULER_COOLDOWN_MINUTES'], 30),
      },
      savingsReconciliation: {
        enabled: readBoolean(env['SAVINGS_RECONCILIATION_SCHEDULER_ENABLED'], false),
        tenantId: readOptionalString(env['SAVINGS_RECONCILIATION_TENANT_ID']),
        batchSize: readPositiveInteger(env['SAVINGS_RECONCILIATION_BATCH_SIZE'], 50),
        runOnStart: readBoolean(env['SAVINGS_RECONCILIATION_RUN_ON_START'], false),
        intervalMs: readPositiveInteger(env['SAVINGS_RECONCILIATION_INTERVAL_MS'], 300_000),
      },
      authCleanup: {
        enabled: readBoolean(env['AUTH_CLEANUP_SCHEDULER_ENABLED'], false),
        intervalMs: readPositiveInteger(env['AUTH_CLEANUP_SCHEDULER_INTERVAL_MS'], 6 * 60 * 60 * 1000),
        batchSize: readPositiveInteger(env['AUTH_CLEANUP_BATCH_SIZE'], 500),
      },
    },
    operations: {
      processHeartbeat: {
        enabled: readBoolean(env['PROCESS_HEARTBEAT_ENABLED'], true),
        intervalMs: readPositiveInteger(env['PROCESS_HEARTBEAT_INTERVAL_MS'], 30_000),
        staleAfterMs: readPositiveInteger(env['PROCESS_HEARTBEAT_STALE_AFTER_MS'], 90_000),
      },
    },
    finops: {
      valueRealizationOutboundEnabled: readBoolean(env['VALUE_REALIZATION_OUTBOUND_ENABLED'], false),
      savingsReconciliationEnabled: readBoolean(env['SAVINGS_RECONCILIATION_ENABLED'], false),
      savingsReconciliationBatchSize: readPositiveInteger(env['SAVINGS_RECONCILIATION_BATCH_SIZE'], 50),
      anomalyMinDeltaUsd: readPositiveNumber(env['ANOMALY_MIN_DELTA_USD'], 1),
    },
  };
}

function readProcessRole(value: string | undefined): ProcessRole {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') return 'all';
  if (normalized === 'api' || normalized === 'worker' || normalized === 'scheduler' || normalized === 'all') {
    return normalized;
  }
  throw new Error('Configuracion runtime invalida. APP_PROCESS_ROLE: Debe ser api, worker, scheduler o all.');
}

function readString(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? fallback : normalized;
}

function readOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === 'true';
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readOptionalNonNegativeNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function optionalAiPricing(env: NodeJS.ProcessEnv): {
  readonly inputCostPerMillionTokensUsd?: number;
  readonly outputCostPerMillionTokensUsd?: number;
} {
  const input = readOptionalNonNegativeNumber(env['AI_INPUT_COST_PER_MILLION_TOKENS_USD']);
  const output = readOptionalNonNegativeNumber(env['AI_OUTPUT_COST_PER_MILLION_TOKENS_USD']);
  return {
    ...(input !== undefined ? { inputCostPerMillionTokensUsd: input } : {}),
    ...(output !== undefined ? { outputCostPerMillionTokensUsd: output } : {}),
  };
}

function readCsv(value: string | undefined, fallback: readonly string[]): readonly string[] {
  const values = value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
  return values.length > 0 ? values : fallback;
}

function readSameSite(value: string | undefined): SameSitePolicy {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'strict' || normalized === 'none' ? normalized : 'lax';
}

function readTrustProxy(value: string | undefined): TrustProxy {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '' || normalized === 'false') return false;
  if (normalized === 'true') return true;
  const hops = Number.parseInt(normalized, 10);
  return Number.isInteger(hops) && hops >= 0 ? hops : value!.trim();
}
