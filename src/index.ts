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

import { AuthService } from './application/services/AuthService.js';
import { BudgetService } from './application/services/BudgetService.js';
import { CostAllocationService } from './application/services/CostAllocationService.js';
import { AgentInstructionService } from './application/services/AgentInstructionService.js';
import { AgentLearningService } from './application/services/AgentLearningService.js';
import { AiObservabilityService } from './application/services/AiObservabilityService.js';
import { CloudConnectionService } from './application/services/CloudConnectionService.js';
import { ContextEngineService } from './application/services/ContextEngineService.js';
import { ContextSummaryBuilderService } from './application/services/ContextSummaryBuilderService.js';
import { CostAnalyticsService } from './application/services/CostAnalyticsService.js';
import { EmailClient } from './application/services/EmailClient.js';
import { FinOpsAiService } from './application/services/FinOpsAiService.js';
import { RecommendationAnalysisService } from './application/services/RecommendationAnalysisService.js';
import { MasterAdminService } from './application/services/MasterAdminService.js';
import { OutboundMessageScheduler } from './application/services/OutboundMessageScheduler.js';
import { OutboundMessageService } from './application/services/OutboundMessageService.js';
import { SavingsReminderService } from './application/services/SavingsReminderService.js';
import { TechnicalMetricsService } from './application/services/TechnicalMetricsService.js';
import { TechnicalRecommendationEvidenceService } from './application/services/ai/TechnicalRecommendationEvidenceService.js';
import { ResourceLinkageReadinessService } from './application/services/ResourceLinkageReadinessService.js';
import { ValueRealizationService } from './application/services/ValueRealizationService.js';
import { TelegramBotService } from './application/services/TelegramBotService.js';
import { TelegramClient } from './application/services/TelegramClient.js';
import { TelegramLinkService } from './application/services/TelegramLinkService.js';
import { TelegramMessageFormatter } from './application/services/TelegramMessageFormatter.js';
import { CloudIngestionWorkerService } from './application/services/CloudIngestionWorkerService.js';
import { startNonOverlappingLoop } from './application/services/NonOverlappingLoop.js';
import { getPrismaClient } from './infrastructure/database/prisma.js';
import { OpenAiCompatibleAiGateway } from './infrastructure/ai/OpenAiCompatibleAiGateway.js';
import { AwsSdkIngestionProvider } from './infrastructure/ingestion/AwsSdkIngestionProvider.js';
import { OciSdkIngestionProvider } from './infrastructure/ingestion/OciSdkIngestionProvider.js';
import { PrismaCloudIngestionJobRepository } from './infrastructure/ingestion/PrismaCloudIngestionJobRepository.js';
import { runPrismaIngestionJobScheduler } from './infrastructure/ingestion/PrismaIngestionJobScheduler.js';
import { PrismaAgentContextRepository } from './infrastructure/repositories/PrismaAgentContextRepository.js';
import { PrismaAuthSessionRepository } from './infrastructure/repositories/PrismaAuthSessionRepository.js';
import { PrismaBudgetRepository } from './infrastructure/repositories/PrismaBudgetRepository.js';
import { PrismaCostAllocationRepository } from './infrastructure/repositories/PrismaCostAllocationRepository.js';
import { PrismaAgentLearningRepository } from './infrastructure/repositories/PrismaAgentLearningRepository.js';
import { PrismaCloudConnectionRepository } from './infrastructure/repositories/PrismaCloudConnectionRepository.js';
import { PrismaCostAnalyticsRepository } from './infrastructure/repositories/PrismaCostAnalyticsRepository.js';
import { PrismaCostRepository } from './infrastructure/repositories/PrismaCostRepository.js';
import { PrismaMasterAdminRepository } from './infrastructure/repositories/PrismaMasterAdminRepository.js';
import { PrismaNotificationRepository } from './infrastructure/repositories/PrismaNotificationRepository.js';
import { PrismaOutboundMessageRepository } from './infrastructure/repositories/PrismaOutboundMessageRepository.js';
import { PrismaRecommendationRepository } from './infrastructure/repositories/PrismaRecommendationRepository.js';
import { PrismaRecommendationAnalysisRunRepository } from './infrastructure/repositories/PrismaRecommendationAnalysisRunRepository.js';
import { queueRecommendationAnalysisAfterIngestion } from './infrastructure/repositories/PrismaRecommendationAnalysisScheduler.js';
import { PrismaResourceMetricRepository } from './infrastructure/repositories/PrismaResourceMetricRepository.js';
import { PrismaResourceLinkageReadinessRepository } from './infrastructure/repositories/PrismaResourceLinkageReadinessRepository.js';
import { PrismaTelegramRepository } from './infrastructure/repositories/PrismaTelegramRepository.js';
import { PrismaUserRepository } from './infrastructure/repositories/PrismaUserRepository.js';
import { PrismaValueRealizationRepository } from './infrastructure/repositories/PrismaValueRealizationRepository.js';
import { validateRuntimeConfig } from './infrastructure/config/runtimeConfig.js';
import { Argon2PasswordHasher } from './infrastructure/security/Argon2PasswordHasher.js';
import { CredentialCipher } from './infrastructure/security/CredentialCipher.js';
import { JwtTokenService } from './infrastructure/security/JwtTokenService.js';
import { runWithDatabaseContext } from './infrastructure/database/tenantContext.js';

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
  validateRuntimeConfig();

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║   FinOps Inteligente — Optimizador de Costos en la Nube      ║
║   FinOps Demo © 2026                                        ║
║   Providers: AWS + Oracle Cloud (OCI)                        ║
╚═══════════════════════════════════════════════════════════════╝
  `);

  const prisma = getPrismaClient();
  const credentialCipher = process.env['CREDENTIAL_ENCRYPTION_KEY']?.trim()
    ? new CredentialCipher()
    : undefined;
  const cloudConnectionRepository = new PrismaCloudConnectionRepository(prisma, credentialCipher);
  const costAnalyticsRepository = new PrismaCostAnalyticsRepository(prisma);
  const costRepository = new PrismaCostRepository(prisma);
  const budgetRepository = new PrismaBudgetRepository(prisma);
  const recommendationRepository = new PrismaRecommendationRepository(prisma);
  const valueRealizationRepository = new PrismaValueRealizationRepository(prisma);
  const costAllocationRepository = new PrismaCostAllocationRepository(prisma, valueRealizationRepository);
  const recommendationAnalysisRepository = new PrismaRecommendationAnalysisRunRepository(prisma);
const resourceMetricRepository = new PrismaResourceMetricRepository(prisma);
const notificationRepository = new PrismaNotificationRepository(prisma);
const outboundMessageRepository = new PrismaOutboundMessageRepository(prisma);
const telegramRepository = new PrismaTelegramRepository(prisma);
  const agentContextRepository = new PrismaAgentContextRepository(prisma);
  const agentLearningRepository = new PrismaAgentLearningRepository(prisma);
  const userRepository = new PrismaUserRepository(prisma);
  const authSessionRepository = new PrismaAuthSessionRepository(prisma);
  const masterAdminRepository = new PrismaMasterAdminRepository(prisma);
  const passwordHasher = new Argon2PasswordHasher();
  const tokenService = new JwtTokenService();
  const authService = new AuthService(userRepository, passwordHasher, tokenService, authSessionRepository);
  const masterAdminService = new MasterAdminService(masterAdminRepository, passwordHasher);
  const ingestionProviders = [new AwsSdkIngestionProvider(), new OciSdkIngestionProvider()];
  const cloudConnectionService = new CloudConnectionService(cloudConnectionRepository, ingestionProviders);
const technicalMetricsService = new TechnicalMetricsService(resourceMetricRepository);
const resourceLinkageReadinessService = new ResourceLinkageReadinessService(new PrismaResourceLinkageReadinessRepository(prisma));
const technicalRecommendationEvidenceService = new TechnicalRecommendationEvidenceService(resourceMetricRepository);
const analyticsService = new CostAnalyticsService(costAnalyticsRepository);
  const budgetService = new BudgetService(budgetRepository, notificationRepository, outboundMessageRepository, telegramRepository);
  const costAllocationService = new CostAllocationService(costAllocationRepository);
  const savingsReminderService = new SavingsReminderService(recommendationRepository, notificationRepository);
  const aiGateway = new OpenAiCompatibleAiGateway();
  const agentInstructionService = new AgentInstructionService(agentContextRepository);
  const learningService = new AgentLearningService(
    recommendationRepository,
    agentLearningRepository,
    aiGateway,
  );
  const contextEngineService = new ContextEngineService(
    agentContextRepository,
    agentInstructionService,
    learningService,
  );
  const aiObservabilityService = new AiObservabilityService(agentContextRepository);
  const contextSummaryBuilderService = new ContextSummaryBuilderService(agentContextRepository);
  const aiService = new FinOpsAiService(
    costAnalyticsRepository,
    recommendationRepository,
aiGateway,
learningService,
contextEngineService,
aiObservabilityService,
technicalRecommendationEvidenceService,
);
  const recommendationAnalysisService = new RecommendationAnalysisService(
    recommendationAnalysisRepository,
    aiService,
    notificationRepository,
  );
const telegramEnabled = process.env['TELEGRAM_ENABLED'] === 'true';
const telegramClient = new TelegramClient(process.env['TELEGRAM_BOT_TOKEN'], telegramEnabled);
const telegramMessageFormatter = new TelegramMessageFormatter();
const emailClient = new EmailClient();
const telegramLinkService = new TelegramLinkService(telegramRepository, telegramClient);
const telegramBotService = new TelegramBotService(
    telegramRepository,
    telegramClient,
    telegramMessageFormatter,
    aiService,
    savingsReminderService,
    recommendationRepository,
  costAnalyticsRepository,
  process.env['TELEGRAM_BOT_USERNAME'],
);
  const outboundMessageService = new OutboundMessageService(
  outboundMessageRepository,
  telegramRepository,
  telegramClient,
  emailClient,
  savingsReminderService,
  recommendationRepository,
  {
    telegramEnabled,
    ...(process.env['TELEGRAM_BOT_USERNAME'] !== undefined ? { telegramBotUsername: process.env['TELEGRAM_BOT_USERNAME'] } : {}),
    ...(process.env['TELEGRAM_WEBHOOK_SECRET'] !== undefined ? { telegramWebhookSecret: process.env['TELEGRAM_WEBHOOK_SECRET'] } : {}),
  },
  );
  const valueRealizationService = new ValueRealizationService(
    valueRealizationRepository,
    recommendationRepository,
    notificationRepository,
    outboundMessageRepository,
    process.env['VALUE_REALIZATION_OUTBOUND_ENABLED'] === 'true'
      ? (measurement) => outboundMessageService.sendValueRealizationUpdate(measurement.tenantId, {
        recommendationId: measurement.recommendationId,
        measurementId: measurement.id,
        status: measurement.status,
        currency: measurement.currency,
        observationStart: measurement.observationStart,
        observationEnd: measurement.observationEnd,
      })
      : undefined,
  );
  const ingestionWorker = process.env['INGESTION_WORKER_ENABLED'] === 'true'
    ? new CloudIngestionWorkerService(
      new PrismaCloudIngestionJobRepository(prisma, credentialCipher ?? new CredentialCipher()),
      ingestionProviders,
      process.env['SAVINGS_RECONCILIATION_ENABLED'] === 'true'
        ? ({ tenantId }) => valueRealizationService.reconcile(tenantId, parsePositiveIntegerEnv('SAVINGS_RECONCILIATION_BATCH_SIZE', 50)).then(() => undefined)
        : undefined,
    )
    : null;

  // ── 4. Iniciar Servidor RESTful ───────────────────────────────────

  const { createExpressServer } = await import('./presentation/server.js');
const app = createExpressServer({
    authService,
    cloudConnectionService,
    technicalMetricsService,
    resourceLinkageReadinessService,
    analyticsService,
    budgetService,
    costAllocationService,
    aiService,
    recommendationAnalysisService,
    agentInstructionService,
    agentContextRepository,
    contextSummaryBuilderService,
    savingsReminderService,
    outboundMessageService,
    telegramBotService,
    telegramLinkService,
    masterAdminService,
    ...(process.env['TELEGRAM_WEBHOOK_SECRET'] !== undefined
      ? { telegramWebhookSecret: process.env['TELEGRAM_WEBHOOK_SECRET'] }
      : {}),
    telegramEnabled,
    learningService,
    costRepository,
  recommendationRepository,
    tokenService,
    authSessionRepository,
    valueRealizationService,
    readinessCheck: async () => {
      await prisma.$queryRaw`SELECT 1`;
    },
  });

if (process.env['MESSAGE_SCHEDULER_ENABLED'] === 'true') {
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

const PORT = process.env['PORT'] || 3000;
  
  const httpServer = app.listen(PORT, () => {
    console.log(`\n🚀 FinOps Backend API running on http://localhost:${PORT}`);
    console.log('   Ingestion providers: AWS SDK + OCI SDK');
    console.log(`   Auth: POST http://localhost:${PORT}/api/v1/auth/login`);
    console.log(`   Cloud Connections: GET http://localhost:${PORT}/api/v1/cloud-connections`);
    console.log(`   Costs: GET http://localhost:${PORT}/api/v1/costs?provider=oci&startDate=...&endDate=...`);
    console.log(`   Recommendations: GET http://localhost:${PORT}/api/v1/recommendations`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: 'info', event: 'shutdown_started', signal }));
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    httpServer.close(() => {
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
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  if (ingestionWorker !== null) {
    const workerId = process.env['INGESTION_WORKER_ID'] ?? `finops-worker-${process.pid}`;
    const intervalMs = Number.parseInt(process.env['INGESTION_WORKER_INTERVAL_MS'] ?? '30000', 10);

    console.log(`   Ingestion worker: enabled (${workerId}, ${intervalMs}ms)`);

    startNonOverlappingLoop({
      run: () => ingestionWorker.runOnce(workerId),
      intervalMs,
      fallbackIntervalMs: 30000,
      onError: (error: unknown) => {
        console.error('Ingestion worker iteration failed:', error);
      },
      onSkip: () => {
        console.warn('Ingestion worker iteration skipped because previous run is still active');
      },
    });
  }

  if (process.env['AGENT_LEARNING_WORKER_ENABLED'] === 'true') {
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
        console.error('Agent learning worker iteration failed:', error);
      },
      onSkip: () => {
        console.warn('Agent learning worker iteration skipped because previous run is still active');
      },
    });
  }

  if (process.env['RECOMMENDATION_ANALYSIS_WORKER_ENABLED'] === 'true') {
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
        console.error('Recommendation analysis worker iteration failed:', error);
      },
      onSkip: () => {
        console.warn('Recommendation analysis iteration skipped because previous run is still active');
      },
    });
  }

  if (process.env['RECOMMENDATION_ANALYSIS_SCHEDULER_ENABLED'] === 'true') {
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
        console.error('Recommendation analysis scheduler iteration failed:', error);
      },
    });
  }

  if (process.env['SAVINGS_RECONCILIATION_ENABLED'] === 'true') {
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
      void runReconciliation().catch((error: unknown) => console.error('Initial value realization reconciliation failed:', error));
    }
    if (process.env['SAVINGS_RECONCILIATION_SCHEDULER_ENABLED'] === 'true') {
      const intervalMs = parsePositiveIntegerEnv('SAVINGS_RECONCILIATION_INTERVAL_MS', 300_000);
      console.log(`   Value realization reconciliation scheduler: enabled (${intervalMs}ms)`);
      startNonOverlappingLoop({
        run: runReconciliation,
        intervalMs,
        fallbackIntervalMs: 300_000,
        onError: (error: unknown) => console.error('Value realization reconciliation iteration failed:', error),
        onSkip: () => console.warn('Value realization reconciliation skipped because previous run is still active'),
      });
    }
  }

  if (process.env['INGESTION_SCHEDULER_ENABLED'] === 'true') {
    const intervalMs = parsePositiveIntegerEnv('INGESTION_SCHEDULER_INTERVAL_MS', 300000);
    const metricWindowMinutes = parsePositiveIntegerEnv('INGESTION_SCHEDULER_METRIC_WINDOW_MINUTES', 30);
    const metricCooldownMinutes = parsePositiveIntegerEnv('INGESTION_SCHEDULER_METRIC_COOLDOWN_MINUTES', 25);
    const billingWindowHours = parsePositiveIntegerEnv('INGESTION_SCHEDULER_BILLING_WINDOW_HOURS', 24);
    const billingCooldownHours = parsePositiveIntegerEnv('INGESTION_SCHEDULER_BILLING_COOLDOWN_HOURS', 6);
    const maxAttempts = parsePositiveIntegerEnv('INGESTION_SCHEDULER_MAX_ATTEMPTS', 1);
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
              metricWindowMinutes,
              metricCooldownMinutes,
              billingWindowHours,
              billingCooldownHours,
              maxAttempts,
            },
            ...(providerCode !== undefined ? { providerCode } : {}),
            ...(connectionId !== undefined ? { connectionId } : {}),
          }),
        );
        console.log(`Ingestion scheduler planned ${result.plannedJobs.length} job(s), created ${result.createdJobs.length}.`);
      },
      onError: (error: unknown) => {
        console.error('Ingestion scheduler iteration failed:', error);
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

// ── Ejecución ─────────────────────────────────────────────────────
//
// Arranca la Composición Raíz. Si `bootstrap` rechaza la promesa por un
// error no controlado durante el arranque, se registra como error fatal y
// el proceso termina con código de salida `1` para que el orquestador
// (Docker, PM2, systemd, etc.) detecte el fallo y reinicie si procede.
bootstrap().catch((error: unknown) => {
  console.error('💥 Fatal error during bootstrap:', error);
  process.exit(1);
});
