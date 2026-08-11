import { randomUUID } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import type { AuthService } from '../application/services/AuthService.js';
import type { PasswordRecoveryService } from '../application/services/PasswordRecoveryService.js';
import type { MfaService } from '../application/services/MfaService.js';
import type { BudgetService } from '../application/services/BudgetService.js';
import type { CostAllocationService } from '../application/services/CostAllocationService.js';
import type { CloudConnectionService } from '../application/services/CloudConnectionService.js';
import type { CostAnalyticsService } from '../application/services/CostAnalyticsService.js';
import type { FinOpsAiService } from '../application/services/FinOpsAiService.js';
import type { RecommendationAnalysisService } from '../application/services/RecommendationAnalysisService.js';
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
import type { IAuthSessionRepository } from '../domain/interfaces/IAuthSessionRepository.js';
import type { ICostRepository } from '../domain/interfaces/ICostRepository.js';
import type { IRecommendationRepository } from '../domain/interfaces/IRecommendationRepository.js';
import type { ITokenService } from '../domain/interfaces/ITokenService.js';
import type { ValueRealizationService } from '../application/services/ValueRealizationService.js';
import type { ResourceLinkageReadinessService } from '../application/services/ResourceLinkageReadinessService.js';
import type { MetricsRegistry } from '../application/observability/MetricsRegistry.js';
import { createHttpErrorHandler, createNotFoundHandler } from './middleware/httpErrorHandler.js';
import { createMetricsAuth } from './middleware/metricsAuth.js';
import { registerApiRoutes } from './registerApiRoutes.js';

/**
 * Dependencias inyectadas en el servidor Express.
 *
 * Cada propiedad es un servicio de aplicación, repositorio de dominio o
 * configuración que los controladores y middlewares necesitan. Se inyectan
 * desde la Composición Raíz (`index.ts`) para mantener desacoplada la capa
 * de presentación de la infraestructura.
 */
export interface ServerDependencies {
  /** Servicio de autenticación (login, emisión de credenciales). */
  readonly authService: AuthService;
  readonly passwordRecoveryService: PasswordRecoveryService;
  readonly mfaService: MfaService;
  readonly budgetService: BudgetService;
  readonly costAllocationService: CostAllocationService;
  /** Servicio de gestión de conexiones a proveedores de nube. */
  readonly cloudConnectionService: CloudConnectionService;
  /** Servicio de métricas técnicas de recursos cloud (CPU, memoria, IOPS, etc.). */
  readonly technicalMetricsService: TechnicalMetricsService;
  /** Servicio de analítica de costos (oportunidades, tendencias, forecast, etc.). */
  readonly analyticsService: CostAnalyticsService;
  /** Servicio de IA FinOps (chat y generación de recomendaciones). */
  readonly aiService: FinOpsAiService;
  readonly recommendationAnalysisService: RecommendationAnalysisService;
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
  /** Repositorio que permite revocar y validar sesiones JWT persistidas. */
  readonly authSessionRepository: IAuthSessionRepository;
  readonly valueRealizationService: ValueRealizationService;
  readonly resourceLinkageReadinessService: ResourceLinkageReadinessService;
  readonly metricsRegistry: MetricsRegistry;
  /** Comprueba dependencias críticas sin exponer detalles de infraestructura. */
  readonly readinessCheck?: () => Promise<void>;
}

/** Crea la aplicación Express con seguridad, rutas, salud, readiness y métricas. */
export function createExpressServer(dependencies: ServerDependencies): Express {
  const app = express();
  app.set('trust proxy', parseTrustProxy(process.env['TRUST_PROXY']));

  // Cabeceras de seguridad HTTP (X-Content-Type-Options, HSTS, etc.).
  // Se monta antes de CORS; helmet no interfiere con las cabeceras CORS.
  app.use(helmet());
  app.use(cors({
    origin: parseCorsOrigins(process.env['CORS_ORIGIN']),
    credentials: true,
  }));
  app.use(createRequestLogger(dependencies.metricsRegistry));
  app.use(express.json({ limit: parseBodyLimit(process.env['HTTP_BODY_LIMIT']) }));

  registerApiRoutes(app, dependencies);

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/ready', async (_req, res) => {
    if (dependencies.readinessCheck === undefined) {
      res.status(200).json({ status: 'ready', checks: { database: 'not_configured' } });
      return;
    }

    try {
      await dependencies.readinessCheck();
      res.status(200).json({ status: 'ready', checks: { database: 'ok' } });
    } catch {
      res.status(503).json({ status: 'not_ready', checks: { database: 'failed' } });
    }
  });

  app.get('/metrics', createMetricsAuth(), (_req, res) => {
    res.type('text/plain; version=0.0.4').status(200).send(dependencies.metricsRegistry.toPrometheus());
  });

  app.use(createNotFoundHandler());
  app.use(createHttpErrorHandler());

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

function parseBodyLimit(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? '1mb' : normalized;
}

function createRequestLogger(metrics: MetricsRegistry) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = req.header('x-request-id') ?? randomUUID();
    const startedAt = Date.now();
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);

    res.on('finish', () => {
      const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
      metrics.increment('http_requests_total', { method: req.method, status_class: statusClass });
      metrics.observe('http_request_duration_ms', Date.now() - startedAt, { method: req.method, status_class: statusClass });
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

function parseTrustProxy(value: string | undefined): boolean | number | string {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '' || normalized === 'false') return false;
  if (normalized === 'true') return true;
  const hops = Number.parseInt(normalized, 10);
  return Number.isInteger(hops) && hops >= 0 ? hops : value!.trim();
}
