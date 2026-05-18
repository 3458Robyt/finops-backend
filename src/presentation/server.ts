import express, { type Express } from 'express';
import cors from 'cors';
import type { AuthService } from '../application/services/AuthService.js';
import type { CloudConnectionService } from '../application/services/CloudConnectionService.js';
import type { CostAnalyticsService } from '../application/services/CostAnalyticsService.js';
import type { FinOpsAiService } from '../application/services/FinOpsAiService.js';
import type { AgentInstructionService } from '../application/services/AgentInstructionService.js';
import type { ContextSummaryBuilderService } from '../application/services/ContextSummaryBuilderService.js';
import type { KnowledgeGraphService } from '../application/services/KnowledgeGraphService.js';
import type { SavingsReminderService } from '../application/services/SavingsReminderService.js';
import type { TelegramBotService } from '../application/services/TelegramBotService.js';
import type { TelegramLinkService } from '../application/services/TelegramLinkService.js';
import type { IAgentContextRepository } from '../domain/interfaces/IAgentContextRepository.js';
import type { IAgentLearningService } from '../domain/interfaces/IAgentLearningService.js';
import type { ICostRepository } from '../domain/interfaces/ICostRepository.js';
import type { IRecommendationRepository } from '../domain/interfaces/IRecommendationRepository.js';
import type { ITokenService } from '../domain/interfaces/ITokenService.js';
import { AgentController } from './controllers/AgentController.js';
import { AiController } from './controllers/AiController.js';
import { AnalyticsController } from './controllers/AnalyticsController.js';
import { AuthController } from './controllers/AuthController.js';
import { CloudConnectionController } from './controllers/CloudConnectionController.js';
import { CostController } from './controllers/CostController.js';
import { KpiController } from './controllers/KpiController.js';
import { NotificationController } from './controllers/NotificationController.js';
import { RecommendationController } from './controllers/RecommendationController.js';
import { TelegramController } from './controllers/TelegramController.js';
import { createAuthMiddleware } from './middleware/authMiddleware.js';
import { createAgentRoutes } from './routes/agentRoutes.js';
import { createAiRoutes } from './routes/aiRoutes.js';
import { createAnalyticsRoutes } from './routes/analyticsRoutes.js';
import { createAuthRoutes } from './routes/authRoutes.js';
import { createCloudConnectionRoutes } from './routes/cloudConnectionRoutes.js';
import { createCostRoutes } from './routes/costRoutes.js';
import { createKpiRoutes } from './routes/kpiRoutes.js';
import { createNotificationRoutes } from './routes/notificationRoutes.js';
import { createRecommendationRoutes } from './routes/recommendationRoutes.js';
import { createTelegramRoutes } from './routes/telegramRoutes.js';

interface ServerDependencies {
  readonly authService: AuthService;
  readonly cloudConnectionService: CloudConnectionService;
  readonly analyticsService: CostAnalyticsService;
  readonly aiService: FinOpsAiService;
  readonly agentInstructionService: AgentInstructionService;
  readonly agentContextRepository: IAgentContextRepository;
  readonly contextSummaryBuilderService: ContextSummaryBuilderService;
  readonly knowledgeGraphService: KnowledgeGraphService;
  readonly savingsReminderService: SavingsReminderService;
  readonly telegramBotService: TelegramBotService;
  readonly telegramLinkService: TelegramLinkService;
  readonly telegramWebhookSecret?: string;
  readonly telegramEnabled: boolean;
  readonly learningService?: IAgentLearningService;
  readonly costRepository: ICostRepository;
  readonly recommendationRepository: IRecommendationRepository;
  readonly tokenService: ITokenService;
}

export function createExpressServer(dependencies: ServerDependencies): Express {
  const app = express();

  app.use(cors({
    origin: process.env['CORS_ORIGIN'] ?? 'http://localhost:5173',
    credentials: true,
  }));
  app.use(express.json());

  const aiController = new AiController(dependencies.aiService, dependencies.learningService);
  const agentController = new AgentController(
    dependencies.agentInstructionService,
    dependencies.agentContextRepository,
    dependencies.contextSummaryBuilderService,
    dependencies.knowledgeGraphService,
  );
  const analyticsController = new AnalyticsController(dependencies.analyticsService);
  const authController = new AuthController(dependencies.authService);
  const cloudConnectionController = new CloudConnectionController(
    dependencies.cloudConnectionService,
  );
  const costController = new CostController(dependencies.costRepository);
  const recommendationController = new RecommendationController(
    dependencies.recommendationRepository,
    dependencies.aiService,
    dependencies.learningService,
  );
  const kpiController = new KpiController(dependencies.recommendationRepository);
  const notificationController = new NotificationController(dependencies.savingsReminderService);
  const telegramController = new TelegramController(
    dependencies.telegramBotService,
    dependencies.telegramLinkService,
    dependencies.telegramWebhookSecret,
    dependencies.telegramEnabled,
  );
  const requireAuth = createAuthMiddleware(dependencies.tokenService);

  app.use('/api/v1/agent', createAgentRoutes(agentController, requireAuth));
  app.use('/api/v1/ai', createAiRoutes(aiController, requireAuth));
  app.use('/api/v1/analytics', createAnalyticsRoutes(analyticsController, requireAuth));
  app.use('/api/v1/auth', createAuthRoutes(authController));
  app.use('/api/v1/cloud-connections', createCloudConnectionRoutes(cloudConnectionController, requireAuth));
  app.use('/api/v1/costs', createCostRoutes(costController, requireAuth));
  app.use('/api/v1/kpis', createKpiRoutes(kpiController, requireAuth));
  app.use('/api/v1/notifications', createNotificationRoutes(notificationController, requireAuth));
  app.use('/api/v1/recommendations', createRecommendationRoutes(recommendationController, requireAuth));
  app.use('/api/v1/telegram', createTelegramRoutes(telegramController, requireAuth));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return app;
}
