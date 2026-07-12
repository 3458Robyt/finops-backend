import { randomUUID } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import type { AuthService } from '../application/services/AuthService.js';
import type { BudgetService } from '../application/services/BudgetService.js';
import type { CloudConnectionService } from '../application/services/CloudConnectionService.js';
import type { CostAnalyticsService } from '../application/services/CostAnalyticsService.js';
import type { FinOpsAiService } from '../application/services/FinOpsAiService.js';
import type { AgentInstructionService } from '../application/services/AgentInstructionService.js';
import type { ContextSummaryBuilderService } from '../application/services/ContextSummaryBuilderService.js';
import type { OutboundMessageService } from '../application/services/OutboundMessageService.js';
import type { SavingsReminderService } from '../application/services/SavingsReminderService.js';
import type { TechnicalMetricsService } from '../application/services/TechnicalMetricsService.js';
import type { TelegramBotService } from '../application/services/TelegramBotService.js';
import type { TelegramLinkService } from '../application/services/TelegramLinkService.js';
import type { MasterAdminService } from '../application/services/MasterAdminService.js';
import type { IAgentContextRepository } from '../domain/interfaces/IAgentContextRepository.js';
import type { IAgentLearningService } from '../domain/interfaces/IAgentLearningService.js';
import type { ICostRepository } from '../domain/interfaces/ICostRepository.js';
import type { IRecommendationRepository } from '../domain/interfaces/IRecommendationRepository.js';
import type { ITokenService } from '../domain/interfaces/ITokenService.js';
import { AgentController } from './controllers/AgentController.js';
import { BudgetController } from './controllers/BudgetController.js';
import { AiController } from './controllers/AiController.js';
import { AnalyticsController } from './controllers/AnalyticsController.js';
import { AuthController } from './controllers/AuthController.js';
import { CloudConnectionController } from './controllers/CloudConnectionController.js';
import { CostController } from './controllers/CostController.js';
import { KpiController } from './controllers/KpiController.js';
import { MasterAdminController } from './controllers/MasterAdminController.js';
import { NotificationController } from './controllers/NotificationController.js';
import { OutboundMessageController } from './controllers/OutboundMessageController.js';
import { RecommendationController } from './controllers/RecommendationController.js';
import { TechnicalMetricsController } from './controllers/TechnicalMetricsController.js';
import { TelegramController } from './controllers/TelegramController.js';
import { createAuthMiddleware } from './middleware/authMiddleware.js';
import { createAgentRoutes } from './routes/agentRoutes.js';
import { createBudgetRoutes } from './routes/budgetRoutes.js';
import { createAiRoutes } from './routes/aiRoutes.js';
import { createAnalyticsRoutes } from './routes/analyticsRoutes.js';
import { createAuthRoutes } from './routes/authRoutes.js';
import { createCloudConnectionRoutes } from './routes/cloudConnectionRoutes.js';
import { createCostRoutes } from './routes/costRoutes.js';
import { createIngestionRoutes } from './routes/ingestionRoutes.js';
import { createKpiRoutes } from './routes/kpiRoutes.js';
import { createMasterAdminRoutes } from './routes/masterAdminRoutes.js';
import { createNotificationRoutes } from './routes/notificationRoutes.js';
import { createOutboundMessageRoutes } from './routes/outboundMessageRoutes.js';
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
  readonly budgetService: BudgetService;
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
  /** Servicio de recordatorios de ahorro (genera notificaciones). */
  readonly savingsReminderService: SavingsReminderService;
  /** Servicio de mensajeria externa por Telegram y correo. */
  readonly outboundMessageService: OutboundMessageService;
  /** Servicio del bot de Telegram (procesa actualizaciones del webhook). */
  readonly telegramBotService: TelegramBotService;
  /** Servicio de vinculación de cuentas con Telegram (links). */
  readonly telegramLinkService: TelegramLinkService;
  readonly masterAdminService: MasterAdminService;
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

  // Cabeceras de seguridad HTTP (X-Content-Type-Options, HSTS, etc.).
  // Se monta antes de CORS; helmet no interfiere con las cabeceras CORS.
  app.use(helmet());
  app.use(cors({
    origin: parseCorsOrigins(process.env['CORS_ORIGIN']),
    credentials: true,
  }));
  app.use(createRequestLogger());
  app.use(express.json());

  const globalApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: parsePositiveIntegerEnv('API_RATE_LIMIT_PER_MINUTE', 600),
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      code: 'RATE_LIMITED',
      message: 'Demasiadas solicitudes. Intenta de nuevo mas tarde.',
    },
  });

  // Limitador anti fuerza bruta para el login (POST /api/v1/auth/login).
  const authLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    limit: 10, // 10 intentos por ventana por IP
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      code: 'RATE_LIMITED',
      message: 'Demasiados intentos de inicio de sesión. Intenta de nuevo más tarde.',
    },
  });

  // Limitador anti flood para el webhook de Telegram (POST /api/v1/telegram/webhook).
  const telegramWebhookLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minuto
    limit: 120, // 120 updates por minuto por IP
    standardHeaders: true,
    legacyHeaders: false,
  });

  const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: parsePositiveIntegerEnv('AI_RATE_LIMIT_PER_MINUTE', 30),
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      code: 'RATE_LIMITED',
      message: 'Demasiadas solicitudes de IA. Intenta de nuevo mas tarde.',
    },
  });

  const aiController = new AiController(dependencies.aiService, dependencies.learningService);
  const budgetController = new BudgetController(dependencies.budgetService);
  const agentController = new AgentController(
    dependencies.agentInstructionService,
    dependencies.agentContextRepository,
    dependencies.contextSummaryBuilderService,
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
const outboundMessageController = new OutboundMessageController(dependencies.outboundMessageService);
const telegramController = new TelegramController(
    dependencies.telegramBotService,
    dependencies.telegramLinkService,
    dependencies.telegramWebhookSecret,
    dependencies.telegramEnabled,
  );
  const masterAdminController = new MasterAdminController(dependencies.masterAdminService);
  const requireAuth = createAuthMiddleware(dependencies.tokenService);

  // Limitadores específicos montados ANTES de sus routers para ejecutarse primero.
  app.use('/api/v1', globalApiLimiter);
  app.use('/api/v1/auth/login', authLoginLimiter);
  app.use('/api/v1/ai', aiLimiter);
  app.use('/api/v1/telegram/webhook', telegramWebhookLimiter);

  app.use('/api/v1/agent', createAgentRoutes(agentController, requireAuth));
  app.use('/api/v1/ai', createAiRoutes(aiController, requireAuth));
  app.use('/api/v1/analytics', createAnalyticsRoutes(analyticsController, requireAuth));
  app.use('/api/v1/budgets', createBudgetRoutes(budgetController, requireAuth));
  app.use('/api/v1/auth', createAuthRoutes(authController, requireAuth));
  app.use('/api/v1/cloud-connections', createCloudConnectionRoutes(cloudConnectionController, requireAuth));
  app.use('/api/v1/costs', createCostRoutes(costController, requireAuth));
  app.use('/api/v1/ingestion', createIngestionRoutes(cloudConnectionController, requireAuth));
  app.use('/api/v1/technical-metrics', createTechnicalMetricsRoutes(technicalMetricsController, requireAuth));
  app.use('/api/v1/kpis', createKpiRoutes(kpiController, requireAuth));
app.use('/api/v1/master-admin', createMasterAdminRoutes(masterAdminController, requireAuth));
app.use('/api/v1/notifications', createNotificationRoutes(notificationController, requireAuth));
app.use('/api/v1/outbound-messages', createOutboundMessageRoutes(outboundMessageController, requireAuth));
app.use('/api/v1/recommendations', createRecommendationRoutes(recommendationController, requireAuth));
  app.use('/api/v1/telegram', createTelegramRoutes(telegramController, requireAuth));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return app;
}

function parseCorsOrigins(value: string | undefined): string | string[] {
  const raw = value ?? 'http://localhost:5173';
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');

  return origins.length === 1 ? origins[0]! : origins;
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createRequestLogger() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = req.header('x-request-id') ?? randomUUID();
    const startedAt = Date.now();
    res.setHeader('x-request-id', requestId);

    res.on('finish', () => {
      console.log(JSON.stringify({
        level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        event: 'http_request',
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      }));
    });

    next();
  };
}
