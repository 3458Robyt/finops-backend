import type { Request, Response } from 'express';
import type { FinOpsAiService } from '../../application/services/FinOpsAiService.js';
import type { IAgentLearningService } from '../../domain/interfaces/IAgentLearningService.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';
import {
  parseStatus,
  parseString,
} from './recommendation/recommendationRequestParsers.js';
import {
  requireAuth,
  requireRecommendationExecutionRole,
  requireRecommendationId,
} from './recommendation/recommendationRequestGuards.js';
import { respondWithRecommendationError } from './recommendation/recommendationErrorResponse.js';
import {
  handleCreateDecision,
  handleCreateManualExecution,
} from './recommendation/recommendationDecisionHandlers.js';

/**
 * Controlador de la capa de presentación para las recomendaciones de
 * optimización FinOps (montado en `/api/v1/recommendations`). Traduce las
 * peticiones HTTP hacia el repositorio de recomendaciones y los servicios de IA
 * y aprendizaje, y serializa la respuesta al cliente.
 *
 * Gestiona la generación y consulta de planes de ejecución, el registro de
 * ejecuciones manuales, la consulta del timeline, la toma de decisiones
 * (aprobar/rechazar) y la consulta de recomendaciones (detalle y listado).
 *
 * La validación y normalización de la entrada se delega en funciones puras de
 * {@link ./recommendation/recommendationRequestParsers}, las guardas de acceso
 * y entrada básica en {@link ./recommendation/recommendationRequestGuards}, y el
 * mapeo de errores de dominio a HTTP en
 * {@link ./recommendation/recommendationErrorResponse}.
 *
 * Servicios y dependencias que utiliza:
 * - {@link IRecommendationRepository}: persistencia y consulta de recomendaciones,
 *   planes de ejecución, ejecuciones manuales, decisiones y timeline.
 * - {@link FinOpsAiService} (opcional): generación de planes de ejecución; si no
 *   está configurado, el endpoint correspondiente responde 503.
 * - {@link IAgentLearningService} (opcional): procesa el aprendizaje del agente a
 *   partir de las decisiones.
 *
 * Todos los endpoints requieren autenticación; las operaciones de ejecución
 * manual y de decisión exigen además rol `ADMIN`.
 */
export class RecommendationController {
  constructor(
    private readonly recommendationRepository: IRecommendationRepository,
    private readonly aiService?: FinOpsAiService,
    private readonly learningService?: IAgentLearningService,
  ) {}

  /**
   * Genera (mediante IA) un plan de ejecución para una recomendación.
   *
   * Sirve: POST /api/v1/recommendations/:id/execution-plan
   * Autenticación: requerida. Usa `req.auth.tenantId` y `req.auth.userId`.
   *
   * Parámetros de ruta:
   * - `id` (`req.params.id`): identificador de la recomendación.
   *
   * Respuestas:
   * - 200: `{ success: true, executionPlan }` con el plan generado.
   * - 400 VALIDATION_ERROR: falta el `id` de la recomendación.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 503 AI_NOT_CONFIGURED: el servicio de IA no está configurado.
   * - 404 NOT_FOUND / 403 / 409 / 400: errores de dominio (ver {@link respondWithRecommendationError}).
   * - 500: error inesperado al generar el plan.
   */
  public createExecutionPlan = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = requireAuth(req, res);
      if (auth === undefined) return;
      if (!requireRecommendationExecutionRole(res, auth)) return;

      if (this.aiService === undefined) {
        res.status(503).json({
          success: false,
          error: 'AI service is not configured',
          code: 'AI_NOT_CONFIGURED',
        });
        return;
      }

      const recommendationId = requireRecommendationId(res, req.params['id']);
      if (recommendationId === undefined) return;

      const executionPlan = await this.aiService.generateExecutionPlan({
        tenantId: auth.tenantId,
        userId: auth.userId,
        recommendationId,
      });

      res.status(200).json({ success: true, executionPlan });
    } catch (error: unknown) {
      respondWithRecommendationError(res, error, 'An unexpected error occurred generating execution plan');
    }
  };

  /**
   * Devuelve el plan de ejecución más reciente de una recomendación.
   *
   * Sirve: GET /api/v1/recommendations/:id/execution-plans/latest
   * Autenticación: requerida. Usa `req.auth.tenantId`.
   *
   * Parámetros de ruta:
   * - `id` (`req.params.id`): identificador de la recomendación.
   *
   * Respuestas:
   * - 200: `{ success: true, executionPlan }` (puede ser nulo si no existe plan).
   * - 400 VALIDATION_ERROR: falta el `id` de la recomendación.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 404 NOT_FOUND / 403 / 409 / 400: errores de dominio (ver {@link respondWithRecommendationError}).
   * - 500: error inesperado al cargar el plan.
   */
  public getLatestExecutionPlan = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = requireAuth(req, res);
      if (auth === undefined) return;

      const recommendationId = requireRecommendationId(res, req.params['id']);
      if (recommendationId === undefined) return;

      const executionPlan = await this.recommendationRepository.findLatestExecutionPlanByRecommendation(
        auth.tenantId,
        recommendationId,
      );

      res.status(200).json({ success: true, executionPlan });
    } catch (error: unknown) {
      respondWithRecommendationError(res, error, 'An unexpected error occurred loading execution plan');
    }
  };

  /**
   * Registra una ejecución manual de una recomendación y devuelve la ejecución
   * creada junto con la recomendación actualizada.
   *
   * Sirve: POST /api/v1/recommendations/:id/manual-execution
   * Autenticación: requerida. Rol: `ADMIN`. Usa `req.auth.tenantId` y `req.auth.userId`.
   *
   * Parámetros de ruta:
   * - `id` (`req.params.id`): identificador de la recomendación.
   *
   * Cuerpo (`req.body`):
   * - `status` (obligatorio): estado de la ejecución; uno de `PLANNED`,
   *   `EXECUTED`, `PARTIAL`, `CANCELLED`.
   * - `executionPlanId` (opcional): identificador del plan de ejecución asociado.
   * - `executedAt` (opcional): fecha de ejecución (ISO).
   * - `observedMonthlySavings` (opcional): ahorro mensual observado; no puede ser negativo.
   * - `currency` (opcional): divisa; por defecto `USD`.
   * - `notes` (opcional): notas libres.
   * - `evidence` (opcional): evidencia adjunta.
   *
   * Respuestas:
   * - 200: `{ success: true, execution, recommendation }`.
   * - 400 VALIDATION_ERROR: falta `id`/`status`, o `observedMonthlySavings` negativo.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 403: el rol del usuario no es `ADMIN`.
   * - 404 NOT_FOUND / 409 / 400: errores de dominio (ver {@link respondWithRecommendationError}).
   * - 500: error inesperado al registrar la ejecución manual.
   */
  public createManualExecution = async (req: Request, res: Response): Promise<void> => {
    await handleCreateManualExecution(this.recommendationRepository, req, res);
  };

  /**
   * Devuelve el timeline (cronología de eventos) de una recomendación.
   *
   * Sirve: GET /api/v1/recommendations/:id/timeline
   * Autenticación: requerida. Usa `req.auth.tenantId`.
   *
   * Parámetros de ruta:
   * - `id` (`req.params.id`): identificador de la recomendación.
   *
   * Respuestas:
   * - 200: `{ success: true, timeline, meta: { count } }`.
   * - 400 VALIDATION_ERROR: falta el `id` de la recomendación.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 404 NOT_FOUND / 403 / 409 / 400: errores de dominio (ver {@link respondWithRecommendationError}).
   * - 500: error inesperado al cargar el timeline.
   */
  public getTimeline = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = requireAuth(req, res);
      if (auth === undefined) return;

      const recommendationId = requireRecommendationId(res, req.params['id']);
      if (recommendationId === undefined) return;

      const timeline = await this.recommendationRepository.findTimelineByRecommendation(
        auth.tenantId,
        recommendationId,
      );

      res.status(200).json({
        success: true,
        timeline,
        meta: { count: timeline.length },
      });
    } catch (error: unknown) {
      respondWithRecommendationError(res, error, 'An unexpected error occurred loading recommendation timeline');
    }
  };

  /**
   * Registra una decisión (aprobar o rechazar) sobre el plan de ejecución de una
   * recomendación. Valida que el plan exista, pertenezca a la recomendación y
   * haya sido aprobado por la auditoría de IA antes de persistir la decisión, y
   * lanza el procesamiento de aprendizaje del agente.
   *
   * Sirve: POST /api/v1/recommendations/:id/decisions
   * Autenticación: requerida. Rol: `ADMIN`. Usa `req.auth.tenantId` y `req.auth.userId`.
   *
   * Parámetros de ruta:
   * - `id` (`req.params.id`): identificador de la recomendación.
   *
   * Cuerpo (`req.body`):
   * - `executionPlanId` (obligatorio): identificador del plan de ejecución.
   * - `decision` (obligatorio): `APPROVED` o `REJECTED`.
   * - `reasonCode` (obligatorio): código de motivo soportado (ver {@link parseReasonCode}).
   * - `reason` (obligatorio si `decision` es `REJECTED`): motivo en texto libre.
   *
   * Respuestas:
   * - 200: `{ success: true, recommendation, executionPlan, learning }`.
   * - 400 VALIDATION_ERROR: faltan campos obligatorios o falta motivo de rechazo.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 403: el rol del usuario no es `ADMIN`.
   * - 404 NOT_FOUND: el plan no existe o no corresponde a la recomendación.
   * - 409 AI_AUDIT_REJECTED: el plan no fue aprobado por la auditoría de IA.
   * - 500: error inesperado al procesar la decisión.
   */
  public createDecision = async (req: Request, res: Response): Promise<void> => {
    await handleCreateDecision(this.recommendationRepository, this.learningService, req, res);
  };

  /**
   * Devuelve el detalle de una recomendación por su identificador.
   *
   * Sirve: GET /api/v1/recommendations/:id
   * Autenticación: requerida. Usa `req.auth.tenantId`.
   *
   * Parámetros de ruta:
   * - `id` (`req.params.id`): identificador de la recomendación.
   *
   * Respuestas:
   * - 200: `{ success: true, recommendation }`.
   * - 400 VALIDATION_ERROR: falta el `id` de la recomendación.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 404 NOT_FOUND: la recomendación no existe.
   * - 500: error inesperado al cargar el detalle (cualquier excepción se mapea a 500).
   */
  public getRecommendationById = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = requireAuth(req, res);
      if (auth === undefined) return;

      const recommendationId = requireRecommendationId(res, req.params['id']);
      if (recommendationId === undefined) return;

      const recommendation = await this.recommendationRepository.findById(
        auth.tenantId,
        recommendationId,
      );

      if (recommendation === null) {
        res.status(404).json({
          success: false,
          error: 'Recommendation not found',
          code: 'NOT_FOUND',
        });
        return;
      }

      res.status(200).json({ success: true, recommendation });
    } catch {
      res.status(500).json({
        success: false,
        error: 'An unexpected error occurred processing recommendation detail',
      });
    }
  };

  /**
   * Lista las recomendaciones del tenant, con filtros opcionales por estado y
   * cuenta de nube, junto con metadatos de la consulta.
   *
   * Sirve: GET /api/v1/recommendations
   * Autenticación: requerida. Usa `req.auth.tenantId`.
   *
   * Parámetros de consulta (`req.query`):
   * - `status` (opcional): estado de recomendación soportado (ver {@link parseStatus}).
   * - `cloudAccountId` (opcional): filtra por cuenta de nube.
   *
   * Respuestas:
   * - 200: `{ success: true, recommendations, meta }`.
   * - 400 VALIDATION_ERROR: `status` no soportado.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 500: error inesperado al procesar las recomendaciones.
   */
  public getRecommendations = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = requireAuth(req, res);
      if (auth === undefined) return;

      const status = parseStatus(req.query['status']);
      const cloudAccountId = parseString(req.query['cloudAccountId']);
      const externalResourceId = parseString(req.query['externalResourceId']);
      const recommendations = await this.recommendationRepository.findByTenant({
        tenantId: auth.tenantId,
        ...(status !== undefined ? { status } : {}),
        ...(cloudAccountId !== undefined ? { cloudAccountId } : {}),
        ...(externalResourceId !== undefined ? { externalResourceId } : {}),
      });

      res.status(200).json({
        success: true,
        recommendations,
        meta: {
          tenantId: auth.tenantId,
          count: recommendations.length,
          ...(status !== undefined ? { status } : {}),
          ...(cloudAccountId !== undefined ? { cloudAccountId } : {}),
          ...(externalResourceId !== undefined ? { externalResourceId } : {}),
        },
      });
    } catch (error: unknown) {
      if (error instanceof FinOpsBaseError) {
        res.status(400).json({
          success: false,
          error: error.message,
          code: error.code,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'An unexpected error occurred processing recommendations',
      });
    }
  };
}
