import type { PrismaClient } from '../generated/prisma/client.js';
import { AgentInstructionService } from '../application/services/AgentInstructionService.js';
import { AgentLearningService } from '../application/services/AgentLearningService.js';
import { AiObservabilityService } from '../application/services/AiObservabilityService.js';
import { AuthService } from '../application/services/AuthService.js';
import { BudgetService } from '../application/services/BudgetService.js';
import { CloudConnectionService } from '../application/services/CloudConnectionService.js';
import { ContextEngineService } from '../application/services/ContextEngineService.js';
import { ContextSummaryBuilderService } from '../application/services/ContextSummaryBuilderService.js';
import { CostAllocationService } from '../application/services/CostAllocationService.js';
import { CostAnalyticsService } from '../application/services/CostAnalyticsService.js';
import { EmailClient } from '../application/services/EmailClient.js';
import { FinOpsAiService } from '../application/services/FinOpsAiService.js';
import { MasterAdminService } from '../application/services/MasterAdminService.js';
import { MfaService } from '../application/services/MfaService.js';
import { OutboundMessageService } from '../application/services/OutboundMessageService.js';
import { PasswordRecoveryService } from '../application/services/PasswordRecoveryService.js';
import { RecommendationAnalysisService } from '../application/services/RecommendationAnalysisService.js';
import { SavingsReminderService } from '../application/services/SavingsReminderService.js';
import { TechnicalMetricsService } from '../application/services/TechnicalMetricsService.js';
import { TelegramBotService } from '../application/services/TelegramBotService.js';
import { TelegramClient } from '../application/services/TelegramClient.js';
import { TelegramLinkService } from '../application/services/TelegramLinkService.js';
import { TelegramMessageFormatter } from '../application/services/TelegramMessageFormatter.js';
import { ValueRealizationService } from '../application/services/ValueRealizationService.js';
import { MetricsRegistry } from '../application/observability/MetricsRegistry.js';
import { TechnicalRecommendationEvidenceService } from '../application/services/ai/TechnicalRecommendationEvidenceService.js';
import { CloudIngestionWorkerService } from '../application/services/CloudIngestionWorkerService.js';
import { ResourceLinkageReadinessService } from '../application/services/ResourceLinkageReadinessService.js';
import { OpenAiCompatibleAiGateway } from '../infrastructure/ai/OpenAiCompatibleAiGateway.js';
import { getPrismaClient } from '../infrastructure/database/prisma.js';
import { validateRuntimeConfig } from '../infrastructure/config/runtimeConfig.js';
import { runWithDatabaseContext } from '../infrastructure/database/tenantContext.js';
import { AwsSdkIngestionProvider } from '../infrastructure/ingestion/AwsSdkIngestionProvider.js';
import { OciSdkIngestionProvider } from '../infrastructure/ingestion/OciSdkIngestionProvider.js';
import { PrismaCloudIngestionJobRepository } from '../infrastructure/ingestion/PrismaCloudIngestionJobRepository.js';
import { PrismaAgentContextRepository } from '../infrastructure/repositories/PrismaAgentContextRepository.js';
import { PrismaAgentLearningRepository } from '../infrastructure/repositories/PrismaAgentLearningRepository.js';
import { PrismaAuthSecurityRepository } from '../infrastructure/repositories/PrismaAuthSecurityRepository.js';
import { PrismaAuthSessionRepository } from '../infrastructure/repositories/PrismaAuthSessionRepository.js';
import { PrismaAccountRecoveryRepository } from '../infrastructure/repositories/PrismaAccountRecoveryRepository.js';
import { PrismaBudgetRepository } from '../infrastructure/repositories/PrismaBudgetRepository.js';
import { PrismaCloudConnectionRepository } from '../infrastructure/repositories/PrismaCloudConnectionRepository.js';
import { PrismaCostAllocationRepository } from '../infrastructure/repositories/PrismaCostAllocationRepository.js';
import { PrismaCostAnalyticsRepository } from '../infrastructure/repositories/PrismaCostAnalyticsRepository.js';
import { PrismaCostRepository } from '../infrastructure/repositories/PrismaCostRepository.js';
import { PrismaMasterAdminRepository } from '../infrastructure/repositories/PrismaMasterAdminRepository.js';
import { PrismaMfaRecoveryCodeRepository } from '../infrastructure/repositories/PrismaMfaRecoveryCodeRepository.js';
import { PrismaMfaRepository } from '../infrastructure/repositories/PrismaMfaRepository.js';
import { PrismaNotificationRepository } from '../infrastructure/repositories/PrismaNotificationRepository.js';
import { PrismaOutboundMessageRepository } from '../infrastructure/repositories/PrismaOutboundMessageRepository.js';
import { PrismaRecommendationAnalysisRunRepository } from '../infrastructure/repositories/PrismaRecommendationAnalysisRunRepository.js';
import { PrismaRecommendationRepository } from '../infrastructure/repositories/PrismaRecommendationRepository.js';
import { PrismaResourceLinkageReadinessRepository } from '../infrastructure/repositories/PrismaResourceLinkageReadinessRepository.js';
import { PrismaResourceMetricRepository } from '../infrastructure/repositories/PrismaResourceMetricRepository.js';
import { PrismaTelegramRepository } from '../infrastructure/repositories/PrismaTelegramRepository.js';
import { PrismaUserRepository } from '../infrastructure/repositories/PrismaUserRepository.js';
import { PrismaValueRealizationRepository } from '../infrastructure/repositories/PrismaValueRealizationRepository.js';
import { CredentialCipher } from '../infrastructure/security/CredentialCipher.js';
import { Argon2PasswordHasher } from '../infrastructure/security/Argon2PasswordHasher.js';
import { JwtTokenService } from '../infrastructure/security/JwtTokenService.js';
import type { IAgentLearningService } from '../domain/interfaces/IAgentLearningService.js';
import type { ServerDependencies } from '../presentation/server.js';

export interface ApplicationComposition {
  readonly prisma: PrismaClient;
  readonly metricsRegistry: MetricsRegistry;
  readonly serverDependencies: ServerDependencies;
  readonly recommendationAnalysisRepository: PrismaRecommendationAnalysisRunRepository;
  readonly recommendationAnalysisService: RecommendationAnalysisService;
  readonly valueRealizationService: ValueRealizationService;
  readonly learningService: AgentLearningService;
  readonly ingestionWorker: CloudIngestionWorkerService | null;
}

export function createApplicationComposition(runsWorkers: boolean): ApplicationComposition {
  validateRuntimeConfig();
  const metricsRegistry = new MetricsRegistry();
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
  const authSecurityRepository = new PrismaAuthSecurityRepository(prisma);
  const accountRecoveryRepository = new PrismaAccountRecoveryRepository(prisma);
  const mfaRepository = new PrismaMfaRepository(prisma);
  const mfaRecoveryCodeRepository = new PrismaMfaRecoveryCodeRepository(prisma);
  const authSessionRepository = new PrismaAuthSessionRepository(prisma, authSecurityRepository);
  const masterAdminRepository = new PrismaMasterAdminRepository(prisma);
  const passwordHasher = new Argon2PasswordHasher();
  const tokenService = new JwtTokenService();
  const mfaService = new MfaService(mfaRepository, credentialCipher, mfaRecoveryCodeRepository);
  const authService = new AuthService(
    userRepository,
    passwordHasher,
    tokenService,
    authSessionRepository,
    authSecurityRepository,
    runWithDatabaseContext,
    mfaService,
  );
  const masterAdminService = new MasterAdminService(masterAdminRepository, passwordHasher);
  const ingestionProviders = [new AwsSdkIngestionProvider(), new OciSdkIngestionProvider()];
  const cloudConnectionService = new CloudConnectionService(cloudConnectionRepository, ingestionProviders);
  const technicalMetricsService = new TechnicalMetricsService(resourceMetricRepository);
  const resourceLinkageReadinessService = new ResourceLinkageReadinessService(
    new PrismaResourceLinkageReadinessRepository(prisma),
  );
  const technicalRecommendationEvidenceService = new TechnicalRecommendationEvidenceService(resourceMetricRepository);
  const analyticsService = new CostAnalyticsService(costAnalyticsRepository);
  const budgetService = new BudgetService(
    budgetRepository,
    notificationRepository,
    outboundMessageRepository,
    telegramRepository,
  );
  const costAllocationService = new CostAllocationService(costAllocationRepository);
  const savingsReminderService = new SavingsReminderService(recommendationRepository, notificationRepository);
  const aiGateway = new OpenAiCompatibleAiGateway(metricsRegistry);
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
  const passwordRecoveryService = new PasswordRecoveryService(
    accountRecoveryRepository,
    passwordHasher,
    authSessionRepository,
    emailClient,
  );
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
      ...(process.env['TELEGRAM_BOT_USERNAME'] !== undefined
        ? { telegramBotUsername: process.env['TELEGRAM_BOT_USERNAME'] }
        : {}),
      ...(process.env['TELEGRAM_WEBHOOK_SECRET'] !== undefined
        ? { telegramWebhookSecret: process.env['TELEGRAM_WEBHOOK_SECRET'] }
        : {}),
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
  const ingestionWorker = runsWorkers && process.env['INGESTION_WORKER_ENABLED'] === 'true'
    ? new CloudIngestionWorkerService(
      new PrismaCloudIngestionJobRepository(prisma, credentialCipher ?? new CredentialCipher()),
      ingestionProviders,
      process.env['SAVINGS_RECONCILIATION_ENABLED'] === 'true'
        ? ({ tenantId }) => valueRealizationService.reconcile(
          tenantId,
          parsePositiveIntegerEnv('SAVINGS_RECONCILIATION_BATCH_SIZE', 50),
        ).then(() => undefined)
        : undefined,
      metricsRegistry,
    )
    : null;

  const serverDependencies: ServerDependencies = {
    authService,
    passwordRecoveryService,
    mfaService,
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
    learningService: learningService as IAgentLearningService,
    costRepository,
    recommendationRepository,
    tokenService,
    authSessionRepository,
    valueRealizationService,
    readinessCheck: async () => {
      await prisma.$queryRawUnsafe('SELECT 1');
    },
    metricsRegistry,
  };

  return {
    prisma,
    metricsRegistry,
    serverDependencies,
    recommendationAnalysisRepository,
    recommendationAnalysisService,
    valueRealizationService,
    learningService,
    ingestionWorker,
  };
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
