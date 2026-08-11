/**
 * ═══════════════════════════════════════════════════════════════
 * FinOps Inteligente — Entry Point (Composition Root)
 * ═══════════════════════════════════════════════════════════════
 *
 * Punto de entrada principal de la aplicación.
 * Aquí se realiza la Composición Raíz (Composition Root):
 *   1. Instanciar adaptadores de proveedores de nube.
 *   2. Registrarlos en el mapa de proveedores (DI manual).
 *   3. Instanciar el servicio de ingesta.
 *   4. Ejecutar una ingesta de demostración.
 *
 * En producción, este archivo se reemplazaría por un servidor
 * HTTP (Express/Fastify) que expone la API REST y utiliza un
 * contenedor de DI más robusto (tsyringe, inversify, etc.).
 *
 * @module index
 */

import 'dotenv/config';

import { OutboundMessageScheduler } from './application/services/OutboundMessageScheduler.js';
import { safeErrorMessage } from './application/observability/safeError.js';
import { createApplicationComposition } from './bootstrap/applicationComposition.js';
import { runWithDatabaseContext } from './infrastructure/database/tenantContext.js';
import { runPrismaIngestionJobScheduler } from './infrastructure/ingestion/PrismaIngestionJobScheduler.js';
import { createExpressServer } from './presentation/server.js';
import { queueRecommendationAnalysisAfterIngestion } from './infrastructure/repositories/PrismaRecommendationAnalysisScheduler.js';
import { startNonOverlappingLoop } from './application/services/NonOverlappingLoop.js';


/**
 * Composición Raíz (Composition Root) — Configuración y arranque de la aplicación.
 *
 * Aquí se ensambla todo el grafo de dependencias de forma manual y se
 * arranca el servidor HTTP. Pasos principales:
 *
 *   1. Instanciar adaptadores de proveedores de nube (AWS y, opcionalmente,
 *      OCI) dentro de bloques `try/catch`: si un proveedor falla al
 *      inicializarse (p. ej. faltan credenciales) se registra un warning y
 *      se omite, sin abortar el arranque. Los proveedores válidos se
 *      registran en `providerRegistry`.
 *   2. Crear el cliente Prisma y los repositorios Prisma (conexiones,
 *      analítica, costos, recomendaciones, notificaciones, Telegram,
 *      contexto y aprendizaje del agente, usuarios).
 *   3. Instanciar los servicios de aplicación (autenticación, conexiones,
 *      analítica, recordatorios de ahorro, IA, contexto del agente,
 *      Telegram, ingesta de datos, etc.) inyectando sus dependencias.
 *   4. Construir el servidor Express con `createExpressServer` y ponerlo a
 *      escuchar en el puerto indicado por `process.env.PORT` (por defecto
 *      `3000`), registrando en consola las rutas principales.
 *
 * @returns Promesa que se resuelve una vez el servidor HTTP queda escuchando.
 */
async function bootstrap(): Promise<void> {
  const processRole = readProcessRole();
  const runsApi = processRole === 'api' || processRole === 'all';
  const runsWorkers = processRole === 'worker' || processRole === 'all';
  const runsSchedulers = processRole === 'scheduler' || processRole === 'all';

  console.log('\nFinOps Inteligente — Optimizador de Costos en la Nube\nFinOps Demo © 2026\nProviders: AWS + Oracle Cloud (OCI)\n');

  const composition = createApplicationComposition(runsWorkers);
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
  const PORT = process.env['PORT'] || 3000;

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
    httpServer.requestTimeout = parsePositiveIntegerEnv('HTTP_REQUEST_TIMEOUT_MS', 120_000);
    httpServer.headersTimeout = Math.min(
      parsePositiveIntegerEnv('HTTP_HEADERS_TIMEOUT_MS', 15_000),
      httpServer.requestTimeout,
    );
    httpServer.keepAliveTimeout = parsePositiveIntegerEnv('HTTP_KEEP_ALIVE_TIMEOUT_MS', 5_000);
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
if (runsSchedulers && process.env['MESSAGE_SCHEDULER_ENABLED'] === 'true') {
  const schedulerTenantId = process.env['MESSAGE_SCHEDULER_TENANT_ID'];
  const schedulerUserId = process.env['MESSAGE_SCHEDULER_USER_ID'];
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
      Number.parseInt(process.env['MESSAGE_SCHEDULER_INTERVAL_MINUTES'] ?? '1440', 10),
    );
    scheduler.start();
  }
}

  if (ingestionWorker !== null) {
    const workerId = process.env['INGESTION_WORKER_ID'] ?? `finops-worker-${process.pid}`;
    const intervalMs = Number.parseInt(process.env['INGESTION_WORKER_INTERVAL_MS'] ?? '30000', 10);

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

  if (runsWorkers && process.env['AGENT_LEARNING_WORKER_ENABLED'] === 'true') {
    const workerId = process.env['AGENT_LEARNING_WORKER_ID'] ?? `finops-learning-${process.pid}`;
    const intervalMs = parsePositiveIntegerEnv('AGENT_LEARNING_WORKER_INTERVAL_MS', 5000);

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

  if (runsWorkers && process.env['RECOMMENDATION_ANALYSIS_WORKER_ENABLED'] === 'true') {
    const workerId = process.env['RECOMMENDATION_ANALYSIS_WORKER_ID']
      ?? `finops-analysis-${process.pid}`;
    const intervalMs = parsePositiveIntegerEnv('RECOMMENDATION_ANALYSIS_WORKER_INTERVAL_MS', 5000);
    const staleAfterMs = parsePositiveIntegerEnv(
      'RECOMMENDATION_ANALYSIS_WORKER_STALE_AFTER_MS',
      30 * 60 * 1000,
    );

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

  if (runsSchedulers && process.env['RECOMMENDATION_ANALYSIS_SCHEDULER_ENABLED'] === 'true') {
    const intervalMs = parsePositiveIntegerEnv(
      'RECOMMENDATION_ANALYSIS_SCHEDULER_INTERVAL_MS',
      300_000,
    );
    const cooldownMinutes = parsePositiveIntegerEnv(
      'RECOMMENDATION_ANALYSIS_SCHEDULER_COOLDOWN_MINUTES',
      30,
    );

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

  if (runsSchedulers && process.env['SAVINGS_RECONCILIATION_ENABLED'] === 'true') {
    const reconciliationTenantId = process.env['SAVINGS_RECONCILIATION_TENANT_ID']?.trim();
    const batchSize = parsePositiveIntegerEnv('SAVINGS_RECONCILIATION_BATCH_SIZE', 50);
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

    if (process.env['SAVINGS_RECONCILIATION_RUN_ON_START'] === 'true') {
      void runReconciliation().catch((error: unknown) => console.error(JSON.stringify({ level: 'error', event: 'initial_value_realization_reconciliation_failed', error: safeErrorMessage(error) })));
    }
    if (process.env['SAVINGS_RECONCILIATION_SCHEDULER_ENABLED'] === 'true') {
      const intervalMs = parsePositiveIntegerEnv('SAVINGS_RECONCILIATION_INTERVAL_MS', 300_000);
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

  if (runsSchedulers && process.env['INGESTION_SCHEDULER_ENABLED'] === 'true') {
    const intervalMs = parsePositiveIntegerEnv('INGESTION_SCHEDULER_INTERVAL_MS', 300000);
    const inventoryWindowHours = parsePositiveIntegerEnv('INGESTION_SCHEDULER_INVENTORY_WINDOW_HOURS', 24);
    const inventoryCooldownHours = parsePositiveIntegerEnv('INGESTION_SCHEDULER_INVENTORY_COOLDOWN_HOURS', 24);
    const metricWindowMinutes = parsePositiveIntegerEnv('INGESTION_SCHEDULER_METRIC_WINDOW_MINUTES', 30);
    const metricCooldownMinutes = parsePositiveIntegerEnv('INGESTION_SCHEDULER_METRIC_COOLDOWN_MINUTES', 25);
    const billingWindowHours = parsePositiveIntegerEnv('INGESTION_SCHEDULER_BILLING_WINDOW_HOURS', 24);
    const billingCooldownHours = parsePositiveIntegerEnv('INGESTION_SCHEDULER_BILLING_COOLDOWN_HOURS', 6);
    const maxAttempts = parsePositiveIntegerEnv('INGESTION_SCHEDULER_MAX_ATTEMPTS', 1);
    const validationMaxAgeMinutes = parsePositiveIntegerEnv('INGESTION_SCHEDULER_VALIDATION_MAX_AGE_MINUTES', 1440);
    const providerCode = process.env['INGESTION_SCHEDULER_PROVIDER'];
    const connectionId = process.env['INGESTION_SCHEDULER_CONNECTION_ID'];

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

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

type ProcessRole = 'api' | 'worker' | 'scheduler' | 'all';

function readProcessRole(): ProcessRole {
  const value = process.env['APP_PROCESS_ROLE']?.trim().toLowerCase();
  return value === 'api' || value === 'worker' || value === 'scheduler' || value === 'all'
    ? value
    : 'all';
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
