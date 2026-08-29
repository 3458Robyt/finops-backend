import type { PrismaClient } from '../generated/prisma/client.js';
import { AgentInstructionService } from '../application/services/AgentInstructionService.js';
import { AgentLearningService } from '../application/services/AgentLearningService.js';
import { AgentQualityService } from '../application/services/AgentQualityService.js';
import { AiObservabilityService } from '../application/services/AiObservabilityService.js';
import { AuthService } from '../application/services/AuthService.js';
import { AuthLifecycleCleanupService } from '../application/services/AuthLifecycleCleanupService.js';
import { ProcessHeartbeatService } from '../application/services/ProcessHeartbeatService.js';
import { OperationalReadinessService } from '../application/services/OperationalReadinessService.js';
import { BudgetService } from '../application/services/BudgetService.js';
import { CloudConnectionService } from '../application/services/CloudConnectionService.js';
import { ContextEngineService } from '../application/services/ContextEngineService.js';
import { ContextSummaryBuilderService } from '../application/services/ContextSummaryBuilderService.js';
import { CostAllocationService } from '../application/services/CostAllocationService.js';
import { CostAnalyticsService } from '../application/services/CostAnalyticsService.js';
import { EmailClient } from '../application/services/EmailClient.js';
import { ExecutiveSummaryService } from '../application/services/ExecutiveSummaryService.js';
import { ExecutiveSummaryDeliveryService } from '../application/services/ExecutiveSummaryDeliveryService.js';
import { FinOpsAiService } from '../application/services/FinOpsAiService.js';
import { MasterAdminService } from '../application/services/MasterAdminService.js';
import { MasterAdminIngestionJobService } from '../application/services/MasterAdminIngestionJobService.js';
import { ClientInvitationService } from '../application/services/ClientInvitationService.js';
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
import { loadRuntimeConfig } from '../infrastructure/config/runtimeConfigReader.js';
import type { RuntimeConfig } from '../infrastructure/config/runtimeConfigTypes.js';
import { runWithDatabaseContext } from '../infrastructure/database/tenantContext.js';
import { createProcessIdentity } from './processIdentity.js';
import { AwsSdkIngestionProvider } from '../infrastructure/ingestion/AwsSdkIngestionProvider.js';
import { OciSdkIngestionProvider } from '../infrastructure/ingestion/OciSdkIngestionProvider.js';
import { PrismaCloudIngestionJobRepository } from '../infrastructure/ingestion/PrismaCloudIngestionJobRepository.js';
import { PrismaMetricProjectionWorker } from '../infrastructure/ingestion/PrismaMetricProjectionWorker.js';
import { PrismaAgentContextRepository } from '../infrastructure/repositories/PrismaAgentContextRepository.js';
import { PrismaAgentLearningRepository } from '../infrastructure/repositories/PrismaAgentLearningRepository.js';
import { PrismaAgentQualityRepository } from '../infrastructure/repositories/PrismaAgentQualityRepository.js';
import { PrismaAuthSecurityRepository } from '../infrastructure/repositories/PrismaAuthSecurityRepository.js';
import { PrismaAuthLifecycleCleanupRepository } from '../infrastructure/repositories/PrismaAuthLifecycleCleanupRepository.js';
import { PrismaProcessHeartbeatRepository } from '../infrastructure/repositories/PrismaProcessHeartbeatRepository.js';
import { PrismaOperationalReadinessRepository } from '../infrastructure/repositories/PrismaOperationalReadinessRepository.js';
import { PrismaAuthSessionRepository } from '../infrastructure/repositories/PrismaAuthSessionRepository.js';
import { PrismaAccountRecoveryRepository } from '../infrastructure/repositories/PrismaAccountRecoveryRepository.js';
import { PrismaBudgetRepository } from '../infrastructure/repositories/PrismaBudgetRepository.js';
import { PrismaCloudConnectionRepository } from '../infrastructure/repositories/PrismaCloudConnectionRepository.js';
import { PrismaCostAllocationRepository } from '../infrastructure/repositories/PrismaCostAllocationRepository.js';
import { PrismaCostAnalyticsRepository } from '../infrastructure/repositories/PrismaCostAnalyticsRepository.js';
import { PrismaCostRepository } from '../infrastructure/repositories/PrismaCostRepository.js';
import { PrismaMasterAdminRepository } from '../infrastructure/repositories/PrismaMasterAdminRepository.js';
import { PrismaMasterAdminIngestionJobRepository } from '../infrastructure/repositories/PrismaMasterAdminIngestionJobRepository.js';
import { PrismaClientInvitationRepository } from '../infrastructure/repositories/PrismaClientInvitationRepository.js';
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
import { PrismaFxRateRepository } from '../infrastructure/repositories/PrismaFxRateRepository.js';
import { ColombiaTrmProvider } from '../infrastructure/fx/ColombiaTrmProvider.js';
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
  readonly authLifecycleCleanupService: AuthLifecycleCleanupService;
  readonly processHeartbeatService: ProcessHeartbeatService;
  readonly ingestionWorker: CloudIngestionWorkerService | null;
  readonly metricProjectionWorker: PrismaMetricProjectionWorker | null;
  readonly startupReadinessCheck: () => Promise<void>;
}

export function createApplicationComposition(
  runsIngestionWorker: boolean,
  config: RuntimeConfig = loadRuntimeConfig(),
): ApplicationComposition {
  const metricsRegistry = new MetricsRegistry();
  const prisma = getPrismaClient(config.database);
  const credentialCipher = config.security.credentialEncryptionKey !== undefined
    ? new CredentialCipher(config.security.credentialEncryptionKey, config.security.credentialKeyVersion)
    : undefined;
  const cloudConnectionRepository = new PrismaCloudConnectionRepository(prisma, credentialCipher);
  const costAnalyticsRepository = new PrismaCostAnalyticsRepository(prisma);
  const fxRateRepository = new PrismaFxRateRepository(prisma);
  const costRepository = new PrismaCostRepository(prisma, fxRateRepository, new ColombiaTrmProvider());
  const budgetRepository = new PrismaBudgetRepository(prisma);
  const recommendationRepository = new PrismaRecommendationRepository(prisma);
  const valueRealizationRepository = new PrismaValueRealizationRepository(prisma);
  const costAllocationRepository = new PrismaCostAllocationRepository(prisma, valueRealizationRepository);
  const recommendationAnalysisRepository = new PrismaRecommendationAnalysisRunRepository(prisma);
  const resourceMetricRepository = new PrismaResourceMetricRepository(prisma);
  const resourceLinkageReadinessRepository = new PrismaResourceLinkageReadinessRepository(prisma, config.cloud.requiredTagKeys);
  const notificationRepository = new PrismaNotificationRepository(prisma);
  const outboundMessageRepository = new PrismaOutboundMessageRepository(prisma);
  const telegramRepository = new PrismaTelegramRepository(prisma);
  const agentContextRepository = new PrismaAgentContextRepository(prisma);
  const agentLearningRepository = new PrismaAgentLearningRepository(prisma);
  const agentQualityRepository = new PrismaAgentQualityRepository(prisma);
  const userRepository = new PrismaUserRepository(prisma);
  const authSecurityRepository = new PrismaAuthSecurityRepository(prisma);
  const authLifecycleCleanupService = new AuthLifecycleCleanupService(
    new PrismaAuthLifecycleCleanupRepository(prisma),
    config.schedulers.authCleanup.batchSize,
  );
  const processHeartbeatService = new ProcessHeartbeatService(
    new PrismaProcessHeartbeatRepository(prisma),
    config.operations.processHeartbeat.staleAfterMs,
    metricsRegistry,
  );
  const operationalReadinessService = new OperationalReadinessService(
    new PrismaOperationalReadinessRepository(prisma),
    processHeartbeatService,
    config,
    createProcessIdentity(config.environment.processRole, process.env['HOSTNAME'], process.pid),
  );
  const accountRecoveryRepository = new PrismaAccountRecoveryRepository(prisma);
  const mfaRepository = new PrismaMfaRepository(prisma);
  const mfaRecoveryCodeRepository = new PrismaMfaRecoveryCodeRepository(prisma);
  const authSessionRepository = new PrismaAuthSessionRepository(prisma, authSecurityRepository);
  const masterAdminRepository = new PrismaMasterAdminRepository(prisma);
  const masterAdminIngestionJobRepository = new PrismaMasterAdminIngestionJobRepository(
    prisma,
    config.workers.ingestion.jobLeaseMs,
  );
  const clientInvitationRepository = new PrismaClientInvitationRepository(prisma);
  const passwordHasher = new Argon2PasswordHasher();
  const tokenService = new JwtTokenService({
    ...(config.security.jwtSecret === undefined ? {} : { secret: config.security.jwtSecret }),
    issuer: config.security.jwtIssuer,
    audience: config.security.jwtAudience,
    expiresInSeconds: config.security.jwtExpiresInSeconds,
  });
  const mfaService = new MfaService(mfaRepository, credentialCipher, mfaRecoveryCodeRepository);
  const authService = new AuthService(
    userRepository,
    passwordHasher,
    tokenService,
    authSessionRepository,
    authSecurityRepository,
    runWithDatabaseContext,
    mfaService,
    config.security.mfaRequiredForPrivileged,
    config.security.refreshTokenTtlSeconds,
  );
  const masterAdminService = new MasterAdminService(masterAdminRepository, passwordHasher);
  const masterAdminIngestionJobService = new MasterAdminIngestionJobService(masterAdminIngestionJobRepository, masterAdminRepository);
  const emailClient = new EmailClient(config.email);
  const clientInvitationService = new ClientInvitationService(
    clientInvitationRepository,
    masterAdminRepository,
    passwordHasher,
    outboundMessageRepository,
    emailClient,
  );
  const ingestionProviders = [new AwsSdkIngestionProvider(), new OciSdkIngestionProvider()];
  const cloudConnectionService = new CloudConnectionService(cloudConnectionRepository, ingestionProviders);
  const technicalMetricsService = new TechnicalMetricsService(resourceMetricRepository);
  const resourceLinkageReadinessService = new ResourceLinkageReadinessService(
    resourceLinkageReadinessRepository,
  );
  const technicalRecommendationEvidenceService = new TechnicalRecommendationEvidenceService(resourceMetricRepository);
  const analyticsService = new CostAnalyticsService(costAnalyticsRepository, {
    anomalyThresholds: { minAbsoluteDelta: config.finops.anomalyMinDeltaUsd },
    forecastScenarioDependencies: {
      recommendationRepository,
      valueRealizationRepository,
    },
  });
  const executiveSummaryService = new ExecutiveSummaryService(
    costAnalyticsRepository,
    analyticsService,
    recommendationRepository,
    valueRealizationRepository,
    budgetRepository,
    resourceLinkageReadinessRepository,
  );
  const budgetService = new BudgetService(
    budgetRepository,
    notificationRepository,
    outboundMessageRepository,
    telegramRepository,
  );
  const costAllocationService = new CostAllocationService(costAllocationRepository);
  const savingsReminderService = new SavingsReminderService(recommendationRepository, notificationRepository);
  const aiGateway = new OpenAiCompatibleAiGateway(metricsRegistry, config.ai);
  const agentInstructionService = new AgentInstructionService(agentContextRepository);
  const learningService = new AgentLearningService(
    recommendationRepository,
    agentLearningRepository,
    aiGateway,
    undefined,
    {
      auditorModel: config.ai.auditorModel,
      learningAuditTimeoutMs: config.ai.learningAuditTimeoutMs,
      learningLeaseMs: config.workers.learning.leaseMs,
    },
  );
  const contextEngineService = new ContextEngineService(
    agentContextRepository,
    agentInstructionService,
    learningService,
  );
  const aiObservabilityService = new AiObservabilityService(agentContextRepository);
  const agentQualityService = new AgentQualityService(agentQualityRepository, {
    ...(config.ai.inputCostPerMillionTokensUsd !== undefined ? { inputCostPerMillionTokensUsd: config.ai.inputCostPerMillionTokensUsd } : {}),
    ...(config.ai.outputCostPerMillionTokensUsd !== undefined ? { outputCostPerMillionTokensUsd: config.ai.outputCostPerMillionTokensUsd } : {}),
  });
  const contextSummaryBuilderService = new ContextSummaryBuilderService(agentContextRepository);
  const aiService = new FinOpsAiService(
    costAnalyticsRepository,
    recommendationRepository,
    aiGateway,
    learningService,
    contextEngineService,
    aiObservabilityService,
    technicalRecommendationEvidenceService,
    config.ai,
  );
  const recommendationAnalysisService = new RecommendationAnalysisService(
    recommendationAnalysisRepository,
    aiService,
    notificationRepository,
  );
  const telegramEnabled = config.telegram.enabled;
  const telegramClient = new TelegramClient(config.telegram.botToken, telegramEnabled, config.telegram.timeoutMs);
  const telegramMessageFormatter = new TelegramMessageFormatter();
  const executiveSummaryDeliveryService = new ExecutiveSummaryDeliveryService(
    executiveSummaryService,
    outboundMessageRepository,
    telegramRepository,
    emailClient.enabled,
    telegramEnabled,
  );
  const passwordRecoveryService = new PasswordRecoveryService(
    accountRecoveryRepository,
    passwordHasher,
    authSessionRepository,
    emailClient,
    {
      resetUrl: config.security.passwordResetUrl,
      resetTtlSeconds: config.security.passwordResetTtlSeconds,
    },
  );
  const telegramLinkService = new TelegramLinkService(telegramRepository, telegramClient, config.telegram.botUsername);
  const telegramBotService = new TelegramBotService(
    telegramRepository,
    telegramClient,
    telegramMessageFormatter,
    aiService,
    savingsReminderService,
    recommendationRepository,
    costAnalyticsRepository,
    config.telegram.botUsername,
    telegramLinkService,
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
      ...(config.telegram.botUsername === undefined ? {} : { telegramBotUsername: config.telegram.botUsername }),
      ...(config.telegram.webhookSecret === undefined ? {} : { telegramWebhookSecret: config.telegram.webhookSecret }),
    },
    executiveSummaryDeliveryService,
  );
  const valueRealizationService = new ValueRealizationService(
    valueRealizationRepository,
    recommendationRepository,
    notificationRepository,
    outboundMessageRepository,
    config.finops.valueRealizationOutboundEnabled
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
  const ingestionWorker = runsIngestionWorker && config.workers.ingestion.enabled
    ? new CloudIngestionWorkerService(
      new PrismaCloudIngestionJobRepository(
        prisma,
        credentialCipher ?? new CredentialCipher(
          config.security.credentialEncryptionKey,
          config.security.credentialKeyVersion,
        ),
        config.workers.ingestion.jobLeaseMs,
        config.workers.ingestion.retryBackoffMs,
      ),
      ingestionProviders,
      // The legacy `worker` alias may keep the post-ingestion hook. Granular
      // ingestion workers stay isolated; reconciliation runs in its own role.
      (config.environment.processRole === 'worker' || config.environment.processRole === 'all')
        && config.finops.savingsReconciliationEnabled
        ? ({ tenantId }) => valueRealizationService.reconcile(
          tenantId,
          config.finops.savingsReconciliationBatchSize,
        ).then(() => undefined)
        : undefined,
      metricsRegistry,
      config.workers.ingestion.jobHeartbeatMs,
      config.workers.ingestion.progressUpdateMs,
      config.workers.ingestion.concurrency,
    )
    : null;
  const metricProjectionWorker = runsIngestionWorker && config.workers.metricProjection.enabled
    ? new PrismaMetricProjectionWorker(
      prisma,
      metricsRegistry,
      {
        leaseMs: config.workers.metricProjection.leaseMs,
        retryBackoffMs: config.workers.metricProjection.retryBackoffMs,
        transactionTimeoutMs: config.workers.metricProjection.transactionTimeoutMs,
      },
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
    agentQualityService,
    contextSummaryBuilderService,
    savingsReminderService,
    outboundMessageService,
    telegramBotService,
    telegramLinkService,
    masterAdminService,
    masterAdminIngestionJobService,
    clientInvitationService,
    ...(config.telegram.webhookSecret === undefined ? {} : { telegramWebhookSecret: config.telegram.webhookSecret }),
    telegramEnabled,
    learningService: learningService as IAgentLearningService,
    costRepository,
    recommendationRepository,
    tokenService,
    authSessionRepository,
    valueRealizationService,
    readinessCheck: () => operationalReadinessService.check(),
    metricsRegistry,
    runtimeConfig: config,
  };

  return {
    prisma,
    metricsRegistry,
    serverDependencies,
    recommendationAnalysisRepository,
    recommendationAnalysisService,
    valueRealizationService,
    learningService,
    authLifecycleCleanupService,
    processHeartbeatService,
    ingestionWorker,
    metricProjectionWorker,
    startupReadinessCheck: () => operationalReadinessService.assertStartupReady(),
  };
}
