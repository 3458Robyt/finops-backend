export type ProcessRole =
  | 'api'
  | 'worker'
  | 'scheduler'
  | 'ingestion-worker'
  | 'learning-worker'
  | 'recommendation-analysis-worker'
  | 'savings-reconciliation-worker'
  | 'ingestion-scheduler'
  | 'recommendation-analysis-scheduler'
  | 'notification-scheduler'
  | 'auth-cleanup-scheduler'
  | 'budget-scheduler'
  | 'all';
export type TrustProxy = boolean | number | string;
export type SameSitePolicy = 'strict' | 'lax' | 'none';

export interface RuntimeConfig {
  readonly environment: {
    readonly nodeEnv: string;
    readonly isProduction: boolean;
    readonly processRole: ProcessRole;
  };
  readonly http: {
    readonly port: number;
    readonly corsOrigins: readonly string[];
    readonly bodyLimit: string;
    readonly trustProxy: TrustProxy;
    readonly requestTimeoutMs: number;
    readonly headersTimeoutMs: number;
    readonly keepAliveTimeoutMs: number;
    readonly apiRateLimitPerMinute: number;
    readonly aiRateLimitPerMinute: number;
  };
  readonly database: {
    readonly url: string | undefined;
    readonly runtimeEnforce: boolean;
    readonly runtimeRole: string;
    readonly expectedMigration: string | undefined;
  };
  readonly security: {
    readonly jwtSecret: string | undefined;
    readonly jwtIssuer: string;
    readonly jwtAudience: string;
    readonly jwtExpiresInSeconds: number;
    readonly refreshTokenTtlSeconds: number;
    readonly cookieSameSite: SameSitePolicy;
    readonly credentialEncryptionKey: string | undefined;
    readonly credentialKeyVersion: string;
    readonly mfaRequiredForPrivileged: boolean;
    readonly metricsToken: string | undefined;
    readonly passwordResetUrl: string;
    readonly passwordResetTtlSeconds: number;
    readonly clientPortalUrl: string;
  };
  readonly ai: {
    readonly apiKey: string | undefined;
    readonly baseUrl: string;
    readonly model: string;
    readonly auditorModel: string;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly learningAuditTimeoutMs: number;
    readonly inputCostPerMillionTokensUsd?: number;
    readonly outputCostPerMillionTokensUsd?: number;
  };
  readonly cloud: {
    readonly requiredTagKeys: readonly string[];
  };
  readonly email: {
    readonly enabled: boolean;
    readonly timeoutMs: number;
    readonly host: string | undefined;
    readonly port: number;
    readonly secure: boolean;
    readonly user: string | undefined;
    readonly password: string | undefined;
    readonly from: string | undefined;
    readonly fromName: string;
  };
  readonly telegram: {
    readonly enabled: boolean;
    readonly timeoutMs: number;
    readonly botToken: string | undefined;
    readonly botUsername: string | undefined;
    readonly webhookSecret: string | undefined;
  };
  readonly workers: {
    readonly ingestion: {
      readonly enabled: boolean;
      readonly id: string | undefined;
      readonly intervalMs: number;
      readonly jobLeaseMs: number;
      readonly jobHeartbeatMs: number;
      readonly concurrency: number;
      readonly retryBackoffMs: number;
      readonly progressUpdateMs: number;
    };
    readonly learning: { readonly enabled: boolean; readonly id: string | undefined; readonly intervalMs: number; readonly leaseMs: number };
    readonly recommendationAnalysis: {
      readonly enabled: boolean;
      readonly id: string | undefined;
      readonly intervalMs: number;
      readonly staleAfterMs: number;
    };
  };
  readonly schedulers: {
    readonly message: {
      readonly enabled: boolean;
      readonly tenantId: string | undefined;
      readonly userId: string | undefined;
      readonly intervalMinutes: number;
      readonly deliveryBatchSize: number;
      readonly deliveryLeaseMs: number;
      readonly deliveryRetryBackoffMs: number;
    };
    readonly ingestion: {
      readonly enabled: boolean;
      readonly intervalMs: number;
      readonly inventoryWindowHours: number;
      readonly inventoryCooldownHours: number;
      readonly metricWindowMinutes: number;
      readonly metricCooldownMinutes: number;
      readonly billingWindowHours: number;
      readonly billingCooldownHours: number;
      readonly maxAttempts: number;
      readonly validationMaxAgeMinutes: number;
      readonly provider: string | undefined;
      readonly connectionId: string | undefined;
    };
    readonly recommendationAnalysis: {
      readonly enabled: boolean;
      readonly intervalMs: number;
      readonly cooldownMinutes: number;
    };
    readonly savingsReconciliation: {
      readonly enabled: boolean;
      readonly tenantId: string | undefined;
      readonly batchSize: number;
      readonly runOnStart: boolean;
      readonly intervalMs: number;
    };
    readonly authCleanup: {
      readonly enabled: boolean;
      readonly intervalMs: number;
      readonly batchSize: number;
    };
    readonly budget: {
      readonly enabled: boolean;
      readonly tenantId: string | undefined;
      readonly userId: string | undefined;
      readonly intervalMs: number;
    };
  };
  readonly operations: {
    readonly processHeartbeat: {
      readonly enabled: boolean;
      readonly intervalMs: number;
      readonly staleAfterMs: number;
    };
  };
  readonly finops: {
    readonly valueRealizationOutboundEnabled: boolean;
    readonly savingsReconciliationEnabled: boolean;
    readonly savingsReconciliationBatchSize: number;
    readonly anomalyMinDeltaUsd: number;
  };
}
