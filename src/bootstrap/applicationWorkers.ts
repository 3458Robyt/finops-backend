import type { CloudIngestionProvider } from '../domain/interfaces/ICloudIngestionProvider.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { MetricsRegistry } from '../application/observability/MetricsRegistry.js';
import { CloudIngestionWorkerService } from '../application/services/CloudIngestionWorkerService.js';
import type { CostAnalyticsService } from '../application/services/CostAnalyticsService.js';
import type { ValueRealizationService } from '../application/services/ValueRealizationService.js';
import type { RuntimeConfig } from '../infrastructure/config/runtimeConfigTypes.js';
import { PrismaCloudIngestionJobRepository } from '../infrastructure/ingestion/PrismaCloudIngestionJobRepository.js';
import { PrismaMetricProjectionWorker } from '../infrastructure/ingestion/PrismaMetricProjectionWorker.js';
import { CredentialCipher } from '../infrastructure/security/CredentialCipher.js';

export interface ApplicationWorkers {
  readonly ingestionWorker: CloudIngestionWorkerService | null;
  readonly metricProjectionWorker: PrismaMetricProjectionWorker | null;
}

export function createApplicationWorkers(input: {
  readonly runsIngestionWorker: boolean;
  readonly config: RuntimeConfig;
  readonly prisma: PrismaClient;
  readonly credentialCipher?: CredentialCipher | undefined;
  readonly ingestionProviders: readonly CloudIngestionProvider[];
  readonly valueRealizationService: ValueRealizationService;
  readonly analyticsService: CostAnalyticsService;
  readonly metricsRegistry: MetricsRegistry;
}): ApplicationWorkers {
  const { config } = input;
  const ingestionWorker = input.runsIngestionWorker && config.workers.ingestion.enabled
    ? new CloudIngestionWorkerService(
      new PrismaCloudIngestionJobRepository(
        input.prisma,
        input.credentialCipher ?? new CredentialCipher(
          config.security.credentialEncryptionKey,
          config.security.credentialKeyVersion,
        ),
        config.workers.ingestion.jobLeaseMs,
        config.workers.ingestion.retryBackoffMs,
      ),
      input.ingestionProviders,
      (config.environment.processRole === 'worker' || config.environment.processRole === 'all')
        ? async ({ tenantId, sourceType }) => {
          if (config.finops.savingsReconciliationEnabled) {
            await input.valueRealizationService.reconcile(
              tenantId,
              config.finops.savingsReconciliationBatchSize,
            );
          }
          if (sourceType === 'BILLING_EXPORT') {
            await input.analyticsService.recompute({ tenantId });
          }
        }
        : undefined,
      input.metricsRegistry,
      config.workers.ingestion.jobHeartbeatMs,
      config.workers.ingestion.progressUpdateMs,
      config.workers.ingestion.concurrency,
    )
    : null;

  const metricProjectionWorker = input.runsIngestionWorker && config.workers.metricProjection.enabled
    ? new PrismaMetricProjectionWorker(
      input.prisma,
      input.metricsRegistry,
      {
        leaseMs: config.workers.metricProjection.leaseMs,
        retryBackoffMs: config.workers.metricProjection.retryBackoffMs,
        transactionTimeoutMs: config.workers.metricProjection.transactionTimeoutMs,
      },
    )
    : null;

  return { ingestionWorker, metricProjectionWorker };
}
