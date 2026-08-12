import type { ApplicationComposition } from './applicationComposition.js';
import { OutboundMessageScheduler } from '../application/services/OutboundMessageScheduler.js';
import { safeErrorMessage } from '../application/observability/safeError.js';
import type { NonOverlappingLoopOptions } from '../application/services/NonOverlappingLoop.js';
import type { RuntimeConfig } from '../infrastructure/config/runtimeConfigTypes.js';
import { runWithDatabaseContext } from '../infrastructure/database/tenantContext.js';
import { runPrismaIngestionJobScheduler } from '../infrastructure/ingestion/PrismaIngestionJobScheduler.js';
import { queueRecommendationAnalysisAfterIngestion } from '../infrastructure/repositories/PrismaRecommendationAnalysisScheduler.js';
import { startProcessHeartbeat } from './processHeartbeatRuntime.js';
import type { ProcessRoleCapabilities } from './processRoleCapabilities.js';

export interface BackgroundProcessRuntimeInput {
  readonly config: RuntimeConfig;
  readonly capabilities: ProcessRoleCapabilities;
  readonly composition: ApplicationComposition;
  readonly startBackgroundLoop: (options: NonOverlappingLoopOptions) => void;
  readonly registerStop: (stop: () => Promise<void>) => void;
}

/** Arranca únicamente los procesos permitidos por el rol actual. */
export function startBackgroundProcesses(input: BackgroundProcessRuntimeInput): void {
  const { config, composition } = input;
  const { prisma, recommendationAnalysisRepository, recommendationAnalysisService, valueRealizationService, learningService, ingestionWorker } = composition;
  const { outboundMessageService } = composition.serverDependencies;

  startProcessHeartbeat(input, composition.processHeartbeatService);
  startMessageScheduler(input, outboundMessageService);
  startIngestionWorker(input, ingestionWorker);
  startLearningWorker(input, learningService);
  startRecommendationAnalysisWorker(input, recommendationAnalysisService);
  startRecommendationAnalysisScheduler(input, prisma, recommendationAnalysisRepository);
  startSavingsReconciliationScheduler(input, valueRealizationService);
  startIngestionScheduler(input, prisma);
  startAuthLifecycleCleanupScheduler(input, composition.authLifecycleCleanupService);
}

function startMessageScheduler(input: BackgroundProcessRuntimeInput, service: ApplicationComposition['serverDependencies']['outboundMessageService']): void {
  const { config, capabilities } = input;
  if (!capabilities.runsNotificationScheduler || !config.schedulers.message.enabled) return;
  const tenantId = config.schedulers.message.tenantId;
  const userId = config.schedulers.message.userId;
  if (tenantId === undefined || userId === undefined) return;

  const scheduler = new OutboundMessageScheduler(service, {
    tenantId,
    userId,
    email: 'scheduler@system.local',
    role: 'MASTER_ADMIN',
    jwtId: 'scheduler',
  }, {
    intervalMinutes: config.schedulers.message.intervalMinutes,
    deliveryBatchSize: config.schedulers.message.deliveryBatchSize,
    deliveryLeaseMs: config.schedulers.message.deliveryLeaseMs,
    deliveryRetryBackoffMs: config.schedulers.message.deliveryRetryBackoffMs,
    metrics: input.composition.metricsRegistry,
    metricLabels: { process_role: config.environment.processRole },
  });
  scheduler.start();
  input.registerStop(() => scheduler.stop());
}

function startIngestionWorker(input: BackgroundProcessRuntimeInput, worker: ApplicationComposition['ingestionWorker']): void {
  if (!input.capabilities.runsIngestionWorker || worker === null) return;
  const workerId = input.config.workers.ingestion.id ?? `finops-worker-${process.pid}`;
  const intervalMs = input.config.workers.ingestion.intervalMs;
  console.log(`   Ingestion worker: enabled (${workerId}, ${intervalMs}ms)`);
  input.startBackgroundLoop({
    metricName: 'ingestion_worker_iteration',
    run: () => worker.runOnce(workerId),
    intervalMs,
    fallbackIntervalMs: 30_000,
    onError: (error) => console.error(JSON.stringify({ level: 'error', event: 'ingestion_worker_iteration_failed', error: safeErrorMessage(error) })),
    onSkip: () => console.warn('Ingestion worker iteration skipped because previous run is still active'),
  });
}

function startLearningWorker(input: BackgroundProcessRuntimeInput, service: ApplicationComposition['learningService']): void {
  const { config, capabilities } = input;
  if (!capabilities.runsLearningWorker || !config.workers.learning.enabled) return;
  const workerId = config.workers.learning.id ?? `finops-learning-${process.pid}`;
  const intervalMs = config.workers.learning.intervalMs;
  console.log(`   Agent learning worker: enabled (${workerId}, ${intervalMs}ms)`);
  input.startBackgroundLoop({
    metricName: 'learning_worker_iteration',
    run: () => service.processNextQueuedRecommendationDecision(workerId),
    intervalMs,
    fallbackIntervalMs: 5_000,
    onError: (error) => console.error(JSON.stringify({ level: 'error', event: 'agent_learning_worker_iteration_failed', error: safeErrorMessage(error) })),
    onSkip: () => console.warn('Agent learning worker iteration skipped because previous run is still active'),
  });
}

function startRecommendationAnalysisWorker(input: BackgroundProcessRuntimeInput, service: ApplicationComposition['recommendationAnalysisService']): void {
  const { config, capabilities } = input;
  if (!capabilities.runsRecommendationAnalysisWorker || !config.workers.recommendationAnalysis.enabled) return;
  const workerId = config.workers.recommendationAnalysis.id ?? `finops-analysis-${process.pid}`;
  const intervalMs = config.workers.recommendationAnalysis.intervalMs;
  const staleAfterMs = config.workers.recommendationAnalysis.staleAfterMs;
  console.log(`   Recommendation analysis worker: enabled (${workerId}, ${intervalMs}ms)`);
  input.startBackgroundLoop({
    metricName: 'recommendation_analysis_worker_iteration',
    run: () => service.processNext(workerId, staleAfterMs),
    intervalMs,
    fallbackIntervalMs: 5_000,
    onError: (error) => console.error(JSON.stringify({ level: 'error', event: 'recommendation_analysis_worker_iteration_failed', error: safeErrorMessage(error) })),
    onSkip: () => console.warn('Recommendation analysis iteration skipped because previous run is still active'),
  });
}

function startRecommendationAnalysisScheduler(input: BackgroundProcessRuntimeInput, prisma: ApplicationComposition['prisma'], repository: ApplicationComposition['recommendationAnalysisRepository']): void {
  const { config, capabilities } = input;
  if (!capabilities.runsRecommendationAnalysisScheduler || !config.schedulers.recommendationAnalysis.enabled) return;
  const intervalMs = config.schedulers.recommendationAnalysis.intervalMs;
  const cooldownMinutes = config.schedulers.recommendationAnalysis.cooldownMinutes;
  console.log(`   Recommendation analysis scheduler: enabled (${intervalMs}ms)`);
  input.startBackgroundLoop({
    metricName: 'recommendation_analysis_scheduler_iteration',
    run: async () => {
      const queued = await runWithDatabaseContext(
        { workerId: 'recommendation-analysis-scheduler', role: 'MASTER_ADMIN' },
        () => queueRecommendationAnalysisAfterIngestion(prisma, repository, cooldownMinutes),
      );
      if (queued > 0) console.log(`Queued ${queued} post-ingestion analysis run(s).`);
    },
    intervalMs,
    fallbackIntervalMs: 300_000,
    onError: (error) => console.error(JSON.stringify({ level: 'error', event: 'recommendation_analysis_scheduler_iteration_failed', error: safeErrorMessage(error) })),
  });
}

function startSavingsReconciliationScheduler(input: BackgroundProcessRuntimeInput, service: ApplicationComposition['valueRealizationService']): void {
  const { config, capabilities } = input;
  if (!capabilities.runsSavingsReconciliationWorker || !config.finops.savingsReconciliationEnabled) return;
  const tenantId = config.schedulers.savingsReconciliation.tenantId;
  const batchSize = config.finops.savingsReconciliationBatchSize;
  const runReconciliation = async (): Promise<void> => {
    if (tenantId === undefined || tenantId === '') {
      console.warn('Savings reconciliation enabled but SAVINGS_RECONCILIATION_TENANT_ID is not configured');
      return;
    }
    const result = await runWithDatabaseContext(
      { tenantId, role: 'MASTER_ADMIN', workerId: 'value-realization-reconciliation' },
      () => service.reconcile(tenantId, batchSize),
    );
    console.log(JSON.stringify({ level: 'info', event: 'value_realization_reconciliation_completed', ...result }));
  };

  if (config.schedulers.savingsReconciliation.runOnStart) {
    void runReconciliation().catch((error: unknown) => console.error(JSON.stringify({ level: 'error', event: 'initial_value_realization_reconciliation_failed', error: safeErrorMessage(error) })));
  }
  if (!config.schedulers.savingsReconciliation.enabled) return;
  const intervalMs = config.schedulers.savingsReconciliation.intervalMs;
  console.log(`   Value realization reconciliation scheduler: enabled (${intervalMs}ms)`);
  input.startBackgroundLoop({
    metricName: 'savings_reconciliation_worker_iteration',
    run: runReconciliation,
    intervalMs,
    fallbackIntervalMs: 300_000,
    onError: (error) => console.error(JSON.stringify({ level: 'error', event: 'value_realization_reconciliation_iteration_failed', error: safeErrorMessage(error) })),
    onSkip: () => console.warn('Value realization reconciliation skipped because previous run is still active'),
  });
}

function startIngestionScheduler(input: BackgroundProcessRuntimeInput, prisma: ApplicationComposition['prisma']): void {
  const { config, capabilities } = input;
  if (!capabilities.runsIngestionScheduler || !config.schedulers.ingestion.enabled) return;
  const options = config.schedulers.ingestion;
  console.log(`   Ingestion scheduler: enabled (${options.intervalMs}ms)`);
  input.startBackgroundLoop({
    metricName: 'ingestion_scheduler_iteration',
    intervalMs: options.intervalMs,
    fallbackIntervalMs: 300_000,
    run: async () => {
      const result = await runWithDatabaseContext(
        { workerId: 'ingestion-scheduler', role: 'MASTER_ADMIN' },
        () => runPrismaIngestionJobScheduler(prisma, {
          apply: true,
          schedule: {
            now: new Date(),
            inventoryWindowHours: options.inventoryWindowHours,
            inventoryCooldownHours: options.inventoryCooldownHours,
            metricWindowMinutes: options.metricWindowMinutes,
            metricCooldownMinutes: options.metricCooldownMinutes,
            billingWindowHours: options.billingWindowHours,
            billingCooldownHours: options.billingCooldownHours,
            maxAttempts: options.maxAttempts,
            validationMaxAgeMinutes: options.validationMaxAgeMinutes,
          },
          ...(options.provider !== undefined ? { providerCode: options.provider } : {}),
          ...(options.connectionId !== undefined ? { connectionId: options.connectionId } : {}),
        }),
      );
      console.log(`Ingestion scheduler planned ${result.plannedJobs.length} job(s), created ${result.createdJobs.length}.`);
    },
    onError: (error) => console.error(JSON.stringify({ level: 'error', event: 'ingestion_scheduler_iteration_failed', error: safeErrorMessage(error) })),
    onSkip: () => console.warn('Ingestion scheduler iteration skipped because previous run is still active'),
  });
}

function startAuthLifecycleCleanupScheduler(
  input: BackgroundProcessRuntimeInput,
  service: ApplicationComposition['authLifecycleCleanupService'],
): void {
  const { config, capabilities } = input;
  if (!capabilities.runsAuthCleanupScheduler || !config.schedulers.authCleanup.enabled) return;
  const intervalMs = config.schedulers.authCleanup.intervalMs;
  console.log(`   Auth lifecycle cleanup scheduler: enabled (${intervalMs}ms)`);
  input.startBackgroundLoop({
    metricName: 'auth_lifecycle_cleanup_scheduler_iteration',
    intervalMs,
    fallbackIntervalMs: Math.min(intervalMs, 300_000),
    run: () => runWithDatabaseContext(
      { workerId: 'finops-maintenance:auth-lifecycle', role: 'MASTER_ADMIN' },
      async () => {
        const result = await service.runOnce();
        console.log(JSON.stringify({ level: 'info', event: 'auth_lifecycle_cleanup_completed', ...result }));
        return result;
      },
    ),
    onError: (error) => console.error(JSON.stringify({ level: 'error', event: 'auth_lifecycle_cleanup_failed', error: safeErrorMessage(error) })),
    onSkip: () => console.warn('Auth lifecycle cleanup skipped because previous run is still active'),
  });
}
