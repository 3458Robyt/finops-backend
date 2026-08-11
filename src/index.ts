/**
 * ═══════════════════════════════════════════════════════════════
 * FinOps Inteligente — Entry Point (Composition Root)
 * ═══════════════════════════════════════════════════════════════
 *
 * Punto de entrada principal de la aplicación. La composición de dependencias
 * vive en `bootstrap/applicationComposition.ts`; este archivo coordina los
 * roles de proceso, el servidor HTTP, workers, schedulers y el cierre ordenado.
 *
 * @module index
 */

import 'dotenv/config';

import { OutboundMessageScheduler } from './application/services/OutboundMessageScheduler.js';
import { safeErrorMessage } from './application/observability/safeError.js';
import { createApplicationComposition } from './bootstrap/applicationComposition.js';
import { loadRuntimeConfig } from './infrastructure/config/runtimeConfigReader.js';
import { runWithDatabaseContext } from './infrastructure/database/tenantContext.js';
import { runPrismaIngestionJobScheduler } from './infrastructure/ingestion/PrismaIngestionJobScheduler.js';
import { createExpressServer } from './presentation/server.js';
import { queueRecommendationAnalysisAfterIngestion } from './infrastructure/repositories/PrismaRecommendationAnalysisScheduler.js';
import { startNonOverlappingLoop } from './application/services/NonOverlappingLoop.js';


/**
 * Arranque de los roles de proceso y del servidor HTTP.
 *
 * Aquí se ensambla todo el grafo de dependencias de forma manual y se
 * arranca el servidor HTTP. Pasos principales:
 *
 * La configuración se lee una sola vez mediante `loadRuntimeConfig` y se
 * comparte con la composición y la capa HTTP.
 *
 * @returns Promesa que se resuelve una vez el servidor HTTP queda escuchando.
 */
async function bootstrap(): Promise<void> {
  const config = loadRuntimeConfig();
  const processRole = config.environment.processRole;
  const runsApi = processRole === 'api' || processRole === 'all';
  const runsWorkers = processRole === 'worker' || processRole === 'all';
  const runsSchedulers = processRole === 'scheduler' || processRole === 'all';

  console.log('\nFinOps Inteligente — Optimizador de Costos en la Nube\nFinOps Demo © 2026\nProviders: AWS + Oracle Cloud (OCI)\n');

  const composition = createApplicationComposition(runsWorkers, config);
  const {
    prisma,
    metricsRegistry,
    serverDependencies,
    recommendationAnalysisRepository,
    recommendationAnalysisService,
    valueRealizationService,
    learningService,
    ingestionWorker,
  } = composition;
  const { outboundMessageService, recommendationRepository } = serverDependencies;
  const app = runsApi ? createExpressServer(serverDependencies) : undefined;

  // ── 4. Iniciar Servidor RESTful ───────────────────────────────────
  const PORT = config.http.port;

  const httpServer = app?.listen(PORT, () => {
    console.log(
      '\nFinOps Backend API running on http://localhost:' + PORT +
      '\nIngestion providers: AWS SDK + OCI SDK' +
      '\nAuth: POST http://localhost:' + PORT + '/api/v1/auth/login' +
      '\nCloud Connections: GET http://localhost:' + PORT + '/api/v1/cloud-connections' +
      '\nCosts: GET http://localhost:' + PORT + '/api/v1/costs?provider=oci&startDate=...&endDate=...' +
      '\nRecommendations: GET http://localhost:' + PORT + '/api/v1/recommendations',
    );
  });
  if (httpServer !== undefined) {
    httpServer.requestTimeout = config.http.requestTimeoutMs;
    httpServer.headersTimeout = Math.min(
      config.http.headersTimeoutMs,
      httpServer.requestTimeout,
    );
    httpServer.keepAliveTimeout = config.http.keepAliveTimeoutMs;
  } else {
    console.log('   Process role: ' + processRole + ' (HTTP API disabled)');
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: 'info', event: 'shutdown_started', signal }));
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    const disconnect = (): void => {
      void prisma.$disconnect()
        .catch((error: unknown) => {
          console.error(JSON.stringify({
            level: 'error',
            event: 'shutdown_database_disconnect_failed',
            errorName: error instanceof Error ? error.name : 'UnknownError',
          }));
        })
        .finally(() => {
          clearTimeout(forceExit);
          process.exit(0);
        });
    };
    if (httpServer === undefined) {
      disconnect();
      return;
    }
    httpServer.close(disconnect);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
if (runsSchedulers && config.schedulers.message.enabled) {
  const schedulerTenantId = config.schedulers.message.tenantId;
  const schedulerUserId = config.schedulers.message.userId;
  if (schedulerTenantId !== undefined && schedulerUserId !== undefined) {
    const scheduler = new OutboundMessageScheduler(
      outboundMessageService,
      {
        tenantId: schedulerTenantId,
        userId: schedulerUserId,
        email: 'scheduler@system.local',
        role: 'MASTER_ADMIN',
        jwtId: 'scheduler',
      },
      config.schedulers.message.intervalMinutes,
    );
    scheduler.start();
  }
}

  if (ingestionWorker !== null) {
    const workerId = config.workers.ingestion.id ?? `finops-worker-${process.pid}`;
    const intervalMs = config.workers.ingestion.intervalMs;

    console.log(`   Ingestion worker: enabled (${workerId}, ${intervalMs}ms)`);

    startNonOverlappingLoop({
      run: () => ingestionWorker.runOnce(workerId),
      intervalMs,
      fallbackIntervalMs: 30000,
      onError: (error: unknown) => {
        console.error(JSON.stringify({ level: 'error', event: 'ingestion_worker_iteration_failed', error: safeErrorMessage(error) }));
      },
      onSkip: () => {
        console.warn('Ingestion worker iteration skipped because previous run is still active');
      },
    });
  }

  if (runsWorkers && config.workers.learning.enabled) {
    const workerId = config.workers.learning.id ?? `finops-learning-${process.pid}`;
    const intervalMs = config.workers.learning.intervalMs;

    console.log(`   Agent learning worker: enabled (${workerId}, ${intervalMs}ms)`);
    startNonOverlappingLoop({
      run: async () => {
        await learningService.processNextQueuedRecommendationDecision(workerId);
      },
      intervalMs,
      fallbackIntervalMs: 5000,
      onError: (error: unknown) => {
        console.error(JSON.stringify({ level: 'error', event: 'agent_learning_worker_iteration_failed', error: safeErrorMessage(error) }));
      },
      onSkip: () => {
        console.warn('Agent learning worker iteration skipped because previous run is still active');
      },
    });
  }

  if (runsWorkers && config.workers.recommendationAnalysis.enabled) {
    const workerId = config.workers.recommendationAnalysis.id
      ?? `finops-analysis-${process.pid}`;
    const intervalMs = config.workers.recommendationAnalysis.intervalMs;
    const staleAfterMs = config.workers.recommendationAnalysis.staleAfterMs;

    console.log(`   Recommendation analysis worker: enabled (${workerId}, ${intervalMs}ms)`);
    startNonOverlappingLoop({
      run: async () => {
        await recommendationAnalysisService.processNext(workerId, staleAfterMs);
      },
      intervalMs,
      fallbackIntervalMs: 5000,
      onError: (error: unknown) => {
        console.error(JSON.stringify({ level: 'error', event: 'recommendation_analysis_worker_iteration_failed', error: safeErrorMessage(error) }));
      },
      onSkip: () => {
        console.warn('Recommendation analysis iteration skipped because previous run is still active');
      },
    });
  }

  if (runsSchedulers && config.schedulers.recommendationAnalysis.enabled) {
    const intervalMs = config.schedulers.recommendationAnalysis.intervalMs;
    const cooldownMinutes = config.schedulers.recommendationAnalysis.cooldownMinutes;

    console.log(`   Recommendation analysis scheduler: enabled (${intervalMs}ms)`);
    startNonOverlappingLoop({
      run: async () => {
        const queued = await runWithDatabaseContext(
          { workerId: 'recommendation-analysis-scheduler', role: 'MASTER_ADMIN' },
          () => queueRecommendationAnalysisAfterIngestion(
            prisma,
            recommendationAnalysisRepository,
            cooldownMinutes,
          ),
        );
        if (queued > 0) console.log(`Queued ${queued} post-ingestion analysis run(s).`);
      },
      intervalMs,
      fallbackIntervalMs: 300_000,
      onError: (error: unknown) => {
        console.error(JSON.stringify({ level: 'error', event: 'recommendation_analysis_scheduler_iteration_failed', error: safeErrorMessage(error) }));
      },
    });
  }

  if (runsSchedulers && config.finops.savingsReconciliationEnabled) {
    const reconciliationTenantId = config.schedulers.savingsReconciliation.tenantId;
    const batchSize = config.finops.savingsReconciliationBatchSize;
    const runReconciliation = async (): Promise<void> => {
      if (reconciliationTenantId === undefined || reconciliationTenantId === '') {
        console.warn('Savings reconciliation enabled but SAVINGS_RECONCILIATION_TENANT_ID is not configured');
        return;
      }
      const result = await runWithDatabaseContext(
        { tenantId: reconciliationTenantId, role: 'MASTER_ADMIN', workerId: 'value-realization-reconciliation' },
        () => valueRealizationService.reconcile(reconciliationTenantId, batchSize),
      );
      console.log(JSON.stringify({ level: 'info', event: 'value_realization_reconciliation_completed', ...result }));
    };

    if (config.schedulers.savingsReconciliation.runOnStart) {
      void runReconciliation().catch((error: unknown) => console.error(JSON.stringify({ level: 'error', event: 'initial_value_realization_reconciliation_failed', error: safeErrorMessage(error) })));
    }
    if (config.schedulers.savingsReconciliation.enabled) {
      const intervalMs = config.schedulers.savingsReconciliation.intervalMs;
      console.log(`   Value realization reconciliation scheduler: enabled (${intervalMs}ms)`);
      startNonOverlappingLoop({
        run: runReconciliation,
        intervalMs,
        fallbackIntervalMs: 300_000,
        onError: (error: unknown) => console.error(JSON.stringify({ level: 'error', event: 'value_realization_reconciliation_iteration_failed', error: safeErrorMessage(error) })),
        onSkip: () => console.warn('Value realization reconciliation skipped because previous run is still active'),
      });
    }
  }

  if (runsSchedulers && config.schedulers.ingestion.enabled) {
    const intervalMs = config.schedulers.ingestion.intervalMs;
    const inventoryWindowHours = config.schedulers.ingestion.inventoryWindowHours;
    const inventoryCooldownHours = config.schedulers.ingestion.inventoryCooldownHours;
    const metricWindowMinutes = config.schedulers.ingestion.metricWindowMinutes;
    const metricCooldownMinutes = config.schedulers.ingestion.metricCooldownMinutes;
    const billingWindowHours = config.schedulers.ingestion.billingWindowHours;
    const billingCooldownHours = config.schedulers.ingestion.billingCooldownHours;
    const maxAttempts = config.schedulers.ingestion.maxAttempts;
    const validationMaxAgeMinutes = config.schedulers.ingestion.validationMaxAgeMinutes;
    const providerCode = config.schedulers.ingestion.provider;
    const connectionId = config.schedulers.ingestion.connectionId;

    console.log(`   Ingestion scheduler: enabled (${intervalMs}ms)`);

    startNonOverlappingLoop({
      intervalMs,
      fallbackIntervalMs: 300000,
      run: async () => {
        const result = await runWithDatabaseContext(
          { workerId: 'ingestion-scheduler', role: 'MASTER_ADMIN' },
          () => runPrismaIngestionJobScheduler(prisma, {
            apply: true,
            schedule: {
              now: new Date(),
              inventoryWindowHours,
              inventoryCooldownHours,
              metricWindowMinutes,
              metricCooldownMinutes,
              billingWindowHours,
              billingCooldownHours,
              maxAttempts,
              validationMaxAgeMinutes,
            },
            ...(providerCode !== undefined ? { providerCode } : {}),
            ...(connectionId !== undefined ? { connectionId } : {}),
          }),
        );
        console.log(`Ingestion scheduler planned ${result.plannedJobs.length} job(s), created ${result.createdJobs.length}.`);
      },
      onError: (error: unknown) => {
        console.error(JSON.stringify({ level: 'error', event: 'ingestion_scheduler_iteration_failed', error: safeErrorMessage(error) }));
      },
      onSkip: () => {
        console.warn('Ingestion scheduler iteration skipped because previous run is still active');
      },
    });
  }
}

// ── Ejecución ─────────────────────────────────────────────────────
//
// Arranca la Composición Raíz. Si `bootstrap` rechaza la promesa por un
// error no controlado durante el arranque, se registra como error fatal y
// el proceso termina con código de salida `1` para que el orquestador
// (Docker, PM2, systemd, etc.) detecte el fallo y reinicie si procede.
bootstrap().catch((error: unknown) => {
  console.error(JSON.stringify({ level: 'error', event: 'bootstrap_failed', error: safeErrorMessage(error) }));
  process.exit(1);
});
