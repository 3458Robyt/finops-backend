import type { Express } from 'express';
import type { ServerDependencies } from './server.js';
import { loadRuntimeConfig } from '../infrastructure/config/runtimeConfigReader.js';
import { AgentController } from './controllers/AgentController.js';
import { AiController } from './controllers/AiController.js';
import { AnalyticsController } from './controllers/AnalyticsController.js';
import { AuthController } from './controllers/AuthController.js';
import { AuthSessionController } from './controllers/AuthSessionController.js';
import { BudgetController } from './controllers/BudgetController.js';
import { CloudConnectionController } from './controllers/CloudConnectionController.js';
import { CostAllocationController } from './controllers/CostAllocationController.js';
import { CostController } from './controllers/CostController.js';
import { KpiController } from './controllers/KpiController.js';
import { MasterAdminController } from './controllers/MasterAdminController.js';
import { MfaController } from './controllers/MfaController.js';
import { NotificationController } from './controllers/NotificationController.js';
import { OutboundMessageController } from './controllers/OutboundMessageController.js';
import { PasswordRecoveryController } from './controllers/PasswordRecoveryController.js';
import { RecommendationAnalysisController } from './controllers/RecommendationAnalysisController.js';
import { RecommendationController } from './controllers/RecommendationController.js';
import { ResourceLinkageController } from './controllers/ResourceLinkageController.js';
import { TechnicalMetricsController } from './controllers/TechnicalMetricsController.js';
import { TelegramController } from './controllers/TelegramController.js';
import { ValueRealizationController } from './controllers/ValueRealizationController.js';
import { createAuthMiddleware, requireRole } from './middleware/authMiddleware.js';
import { createRateLimit } from './middleware/rateLimit.js';
import { createAgentRoutes } from './routes/agentRoutes.js';
import { createAiRoutes } from './routes/aiRoutes.js';
import { createAnalyticsRoutes } from './routes/analyticsRoutes.js';
import { createAuthRoutes } from './routes/authRoutes.js';
import { createBudgetRoutes } from './routes/budgetRoutes.js';
import { createCloudConnectionRoutes } from './routes/cloudConnectionRoutes.js';
import { createCostAllocationRoutes } from './routes/costAllocationRoutes.js';
import { createCostRoutes } from './routes/costRoutes.js';
import { createIngestionRoutes } from './routes/ingestionRoutes.js';
import { createKpiRoutes } from './routes/kpiRoutes.js';
import { createMasterAdminRoutes } from './routes/masterAdminRoutes.js';
import { createNotificationRoutes } from './routes/notificationRoutes.js';
import { createOutboundMessageRoutes } from './routes/outboundMessageRoutes.js';
import { createRecommendationRoutes } from './routes/recommendationRoutes.js';
import { createTechnicalMetricsRoutes } from './routes/technicalMetricsRoutes.js';
import { createTelegramRoutes } from './routes/telegramRoutes.js';
import { createValueRealizationRoutes } from './routes/valueRealizationRoutes.js';
import { rolesForPermission } from '../domain/security/AuthorizationPolicy.js';
import { type AuthCookieConfig } from './auth/authCookie.js';

export function registerApiRoutes(app: Express, dependencies: ServerDependencies): void {
  const config = dependencies.runtimeConfig ?? loadRuntimeConfig();
  const controllers = createControllers(dependencies, config);
  const requireAuth = createAuthMiddleware(dependencies.tokenService, dependencies.authSessionRepository);
  const requireCloudManager = requireRole(rolesForPermission('CLOUD_MANAGE'));
  const requireIngestionManager = requireRole(rolesForPermission('INGESTION_MANAGE'));
  const requireRecommendationGenerator = requireRole(rolesForPermission('RECOMMENDATION_GENERATE'));
  const requireValueRealizationReconcile = requireRole(rolesForPermission('VALUE_RECONCILE'));

  const globalApiLimiter = createRateLimit({
    windowMs: 60 * 1000,
    limit: config.http.apiRateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, code: 'RATE_LIMITED', message: 'Demasiadas solicitudes. Intenta de nuevo mas tarde.' },
  });
  const authLoginLimiter = createRateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, code: 'RATE_LIMITED', message: 'Demasiados intentos de inicio de sesión. Intenta de nuevo más tarde.' },
  });
  const authRefreshLimiter = createRateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, code: 'RATE_LIMITED', message: 'Demasiadas renovaciones de sesión. Inicia sesión nuevamente más tarde.' },
  });
  const authSensitiveLimiter = createRateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, code: 'RATE_LIMITED', message: 'Demasiadas solicitudes de seguridad. Intenta de nuevo más tarde.' },
  });
  const telegramWebhookLimiter = createRateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const aiLimiter = createRateLimit({
    windowMs: 60 * 1000,
    limit: config.http.aiRateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, code: 'RATE_LIMITED', message: 'Demasiadas solicitudes de IA. Intenta de nuevo mas tarde.' },
  });

  app.use('/api/v1', globalApiLimiter);
  app.use('/api/v1/auth/login', authLoginLimiter);
  app.use('/api/v1/auth/refresh', authRefreshLimiter);
  app.use('/api/v1/auth/mfa', authSensitiveLimiter);
  app.use('/api/v1/auth/password-reset', authSensitiveLimiter);
  app.use('/api/v1/ai', aiLimiter);
  app.use('/api/v1/telegram/webhook', telegramWebhookLimiter);

  app.use('/api/v1/agent', createAgentRoutes(controllers.agent, requireAuth));
  app.use('/api/v1/ai', createAiRoutes(controllers.ai, controllers.analysis, requireAuth, requireRecommendationGenerator));
  app.use('/api/v1/analytics', createAnalyticsRoutes(controllers.analytics, requireAuth));
  app.use('/api/v1/budgets', createBudgetRoutes(controllers.budget, requireAuth));
  app.use('/api/v1/cost-allocation', createCostAllocationRoutes(controllers.costAllocation, requireAuth));
  app.use('/api/v1/auth', createAuthRoutes(
    controllers.auth,
    controllers.authSession,
    requireAuth,
    controllers.passwordRecovery,
    controllers.mfa,
    config.http.corsOrigins,
  ));
  app.use('/api/v1/cloud-connections', createCloudConnectionRoutes(controllers.cloudConnection, requireAuth, requireCloudManager));
  app.use('/api/v1/costs', createCostRoutes(controllers.cost, requireAuth));
  app.use('/api/v1/ingestion', createIngestionRoutes(controllers.cloudConnection, requireAuth, requireIngestionManager, controllers.resourceLinkage));
  app.use('/api/v1/technical-metrics', createTechnicalMetricsRoutes(controllers.technicalMetrics, requireAuth));
  app.use('/api/v1/kpis', createKpiRoutes(controllers.kpi, requireAuth));
  app.use('/api/v1/master-admin', createMasterAdminRoutes(controllers.masterAdmin, requireAuth));
  app.use('/api/v1/notifications', createNotificationRoutes(controllers.notification, requireAuth));
  app.use('/api/v1/outbound-messages', createOutboundMessageRoutes(controllers.outbound, requireAuth));
  app.use('/api/v1/recommendations', createRecommendationRoutes(controllers.recommendation, requireAuth));
  app.use('/api/v1/telegram', createTelegramRoutes(controllers.telegram, requireAuth));
  app.use('/api/v1/value-realization', createValueRealizationRoutes(controllers.valueRealization, requireAuth, requireValueRealizationReconcile));
}

function createControllers(dependencies: ServerDependencies, config: NonNullable<ServerDependencies['runtimeConfig']>) {
  const authCookieConfig: AuthCookieConfig = {
    secure: config.environment.isProduction,
    sameSite: config.security.cookieSameSite,
  };
  return {
    agent: new AgentController(dependencies.agentInstructionService, dependencies.agentContextRepository, dependencies.contextSummaryBuilderService),
    ai: new AiController(dependencies.aiService, dependencies.learningService),
    analysis: new RecommendationAnalysisController(dependencies.recommendationAnalysisService),
    analytics: new AnalyticsController(dependencies.analyticsService),
    auth: new AuthController(dependencies.authService, authCookieConfig, config.security.refreshTokenTtlSeconds),
    authSession: new AuthSessionController(dependencies.authService, authCookieConfig, config.security.refreshTokenTtlSeconds),
    passwordRecovery: new PasswordRecoveryController(dependencies.passwordRecoveryService),
    mfa: new MfaController(dependencies.mfaService),
    budget: new BudgetController(dependencies.budgetService),
    costAllocation: new CostAllocationController(dependencies.costAllocationService),
    cloudConnection: new CloudConnectionController(dependencies.cloudConnectionService),
    technicalMetrics: new TechnicalMetricsController(dependencies.technicalMetricsService),
    cost: new CostController(dependencies.costRepository),
    recommendation: new RecommendationController(dependencies.recommendationRepository, dependencies.aiService, dependencies.learningService, dependencies.valueRealizationService),
    kpi: new KpiController(dependencies.recommendationRepository),
    notification: new NotificationController(dependencies.savingsReminderService),
    outbound: new OutboundMessageController(dependencies.outboundMessageService),
    telegram: new TelegramController(dependencies.telegramBotService, dependencies.telegramLinkService, dependencies.telegramWebhookSecret, dependencies.telegramEnabled),
    masterAdmin: new MasterAdminController(dependencies.masterAdminService),
    valueRealization: new ValueRealizationController(dependencies.valueRealizationService),
    resourceLinkage: new ResourceLinkageController(dependencies.resourceLinkageReadinessService),
  };
}
