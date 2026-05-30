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
import type { TechnicalMetricsService } from '../application/services/TechnicalMetricsService.js';
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
import { TechnicalMetricsController } from './controllers/TechnicalMetricsController.js';
import { TelegramController } from './controllers/TelegramController.js';
import { createAuthMiddleware } from './middleware/authMiddleware.js';
import { createAgentRoutes } from './routes/agentRoutes.js';
import { createAiRoutes } from './routes/aiRoutes.js';
import { createAnalyticsRoutes } from './routes/analyticsRoutes.js';
import { createAuthRoutes } from './routes/authRoutes.js';
import { createCloudConnectionRoutes } from './routes/cloudConnectionRoutes.js';
import { createCostRoutes } from './routes/costRoutes.js';
import { createIngestionRoutes } from './routes/ingestionRoutes.js';
import { createKpiRoutes } from './routes/kpiRoutes.js';
import { createNotificationRoutes } from './routes/notificationRoutes.js';
import { createRecommendationRoutes } from './routes/recommendationRoutes.js';
import { createTechnicalMetricsRoutes } from './routes/technicalMetricsRoutes.js';
import { createTelegramRoutes } from './routes/telegramRoutes.js';

/**
 * Dependencias inyectadas en el servidor Express.
 *
 * Cada propiedad es un servicio de aplicación, repositorio de dominio o
 * configuración que los controladores y middlewares necesitan. Se inyectan
 * desde la Composición Raíz (`index.ts`) para mantener desacoplada la capa
 * de presentación de la infraestructura.
 */
interface ServerDependencies {
  /** Servicio de autenticación (login, emisión de credenciales). */
  readonly authService: AuthService;
  /** Servicio de gestión de conexiones a proveedores de nube. */
  readonly cloudConnectionService: CloudConnectionService;
  /** Servicio de métricas técnicas de recursos cloud (CPU, memoria, IOPS, etc.). */
  readonly technicalMetricsService: TechnicalMetricsService;
  /** Servicio de analítica de costos (anomalías, tendencias, forecast, etc.). */
  readonly analyticsService: CostAnalyticsService;
  /** Servicio de IA FinOps (chat y generación de recomendaciones). */
  readonly aiService: FinOpsAiService;
  /** Servicio de instrucciones/perfil del agente. */
  readonly agentInstructionService: AgentInstructionService;
  /** Repositorio del contexto del agente (perfiles, reglas, trazas). */
  readonly agentContextRepository: IAgentContextRepository;
  /** Servicio que construye resúmenes de contexto para el agente. */
  readonly contextSummaryBuilderService: ContextSummaryBuilderService;
  /** Servicio del grafo de conocimiento del agente. */
  readonly knowledgeGraphService: KnowledgeGraphService;
  /** Servicio de recordatorios de ahorro (genera notificaciones). */
  readonly savingsReminderService: SavingsReminderService;
  /** Servicio del bot de Telegram (procesa actualizaciones del webhook). */
  readonly telegramBotService: TelegramBotService;
  /** Servicio de vinculación de cuentas con Telegram (links). */
  readonly telegramLinkService: TelegramLinkService;
  /** Secreto opcional para validar el webhook de Telegram. */
  readonly telegramWebhookSecret?: string;
  /** Indica si la integración con Telegram está habilitada. */
  readonly telegramEnabled: boolean;
  /** Servicio opcional de aprendizaje del agente (feedback/learning). */
  readonly learningService?: IAgentLearningService;
  /** Repositorio de costos diarios. */
  readonly costRepository: ICostRepository;
  /** Repositorio de recomendaciones. */
  readonly recommendationRepository: IRecommendationRepository;
  /** Servicio de tokens usado por el middleware de autenticación. */
  readonly tokenService: ITokenService;
}

/**
 * Crea y configura la aplicación Express con todas sus rutas.
 *
 * Configuración aplicada:
 *   - Middleware CORS: origen tomado de `process.env.CORS_ORIGIN` (por
 *     defecto `http://localhost:5173`) y `credentials: true`.
 *   - Middleware `express.json()` para parsear cuerpos JSON.
 *
 * Controladores instanciados con sus dependencias: `AiController`,
 * `AgentController`, `AnalyticsController`, `AuthController`,
 * `CloudConnectionController`, `CostController`, `RecommendationController`,
 * `KpiController`, `NotificationController` y `TelegramController`. Además
 * crea el middleware `requireAuth` a partir de `tokenService`.
 *
 * Prefijos de ruta montados (todos bajo `/api/v1`):
 *   - `/api/v1/agent`             → `createAgentRoutes`
 *   - `/api/v1/ai`                → `createAiRoutes`
 *   - `/api/v1/analytics`         → `createAnalyticsRoutes`
 *   - `/api/v1/auth`              → `createAuthRoutes` (sin `requireAuth`)
 *   - `/api/v1/cloud-connections` → `createCloudConnectionRoutes`
 *   - `/api/v1/costs`             → `createCostRoutes`
 *   - `/api/v1/kpis`              → `createKpiRoutes`
 *   - `/api/v1/notifications`     → `createNotificationRoutes`
 *   - `/api/v1/recommendations`   → `createRecommendationRoutes`
 *   - `/api/v1/telegram`          → `createTelegramRoutes`
 *
 * Expone además un endpoint de salud `GET /health` que responde `200` con
 * `{ status: 'ok', timestamp }`.
 *
 * Nota: esta función no registra un middleware global de manejo de errores
 * ni un handler 404; cada controlador gestiona sus propias respuestas.
 *
 * @param dependencies Dependencias inyectadas (servicios, repositorios y configuración).
 * @returns Instancia de la aplicación Express lista para escuchar conexiones.
 */
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
  const technicalMetricsController = new TechnicalMetricsController(
    dependencies.technicalMetricsService,
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
  app.use('/api/v1/ingestion', createIngestionRoutes(cloudConnectionController, requireAuth));
  app.use('/api/v1/technical-metrics', createTechnicalMetricsRoutes(technicalMetricsController, requireAuth));
  app.use('/api/v1/kpis', createKpiRoutes(kpiController, requireAuth));
  app.use('/api/v1/notifications', createNotificationRoutes(notificationController, requireAuth));
  app.use('/api/v1/recommendations', createRecommendationRoutes(recommendationController, requireAuth));
  app.use('/api/v1/telegram', createTelegramRoutes(telegramController, requireAuth));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return app;
}
