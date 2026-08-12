import type { Request, Response } from 'express';
import { z } from 'zod';
import type { FinOpsAiService } from '../../application/services/FinOpsAiService.js';
import type { IAgentLearningService } from '../../domain/interfaces/IAgentLearningService.js';
import { respondWithFinOpsError } from '../http/finOpsErrorResponse.js';

const chatSchema = z.object({
  message: z.string().min(1),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1),
  })).optional(),
});

const generateRecommendationsSchema = z.object({
  persist: z.boolean().optional(),
  externalResourceId: z.string().trim().min(1).optional(),
  cloudResourceId: z.string().trim().min(1).optional(),
});

/**
 * Controlador de la capa de presentación para las funcionalidades de IA
 * (montado en `/api/v1/ai`). Traduce las peticiones HTTP hacia los casos de uso
 * de IA y serializa la respuesta al cliente.
 *
 * Expone el chat asistido por IA sobre los costes del tenant, la generación de
 * recomendaciones y el resumen de aprendizaje del agente.
 *
 * Servicios y dependencias que utiliza:
 * - {@link FinOpsAiService}: responder el chat y generar recomendaciones.
 * - {@link IAgentLearningService} (opcional): resumen de aprendizaje del agente;
 *   si no está configurado, el endpoint correspondiente responde 503.
 *
 * Todos los endpoints requieren autenticación.
 */
export class AiController {
  constructor(
    private readonly aiService: FinOpsAiService,
    private readonly learningService?: IAgentLearningService,
  ) {}

  /**
   * Responde a un mensaje de chat del usuario usando el contexto de costes del
   * tenant. Devuelve la respuesta de la IA junto con un resumen del snapshot de
   * costes empleado como contexto.
   *
   * Sirve: POST /api/v1/ai/chat
   * Autenticación: requerida.
   *
   * Cuerpo (`req.body`, validado con `chatSchema`):
   * - `message`: mensaje del usuario (no vacío).
   * - `history` (opcional): historial de turnos `{ role: 'user' | 'assistant', content }`.
   *
   * Usa `req.auth.tenantId` y `req.auth.userId` como contexto.
   *
   * Respuestas:
   * - 200: `{ success: true, answer, context }` con la respuesta y el contexto de costes.
   * - 400 VALIDATION_ERROR: el cuerpo no cumple el esquema.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 400 / 502: errores de dominio (VALIDATION_ERROR -> 400; resto -> 502).
   * - 500: error inesperado del chat IA.
   */
  public chat = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({
        success: false,
        error: 'Authentication is required',
        code: 'AUTHENTICATION_REQUIRED',
      });
      return;
    }

    const parsed = chatSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid chat payload',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    try {
      const result = await this.aiService.answerChat({
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        message: parsed.data.message,
        ...(parsed.data.history !== undefined ? { history: parsed.data.history } : {}),
      });

      res.status(200).json({
        success: true,
        answer: result.answer,
        context: {
          periodStart: result.snapshot.periodStart,
          periodEnd: result.snapshot.periodEnd,
          totalCost: result.snapshot.totalCost,
          currency: result.snapshot.currency,
          metricCount: result.snapshot.metricCount,
        },
      });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'An unexpected AI chat error occurred', 'ai_operation_failed', req.path);
    }
  };

  /**
   * Genera recomendaciones de optimización de costes mediante IA, opcionalmente
   * persistiéndolas. Devuelve las recomendaciones y el contexto de costes usado.
   *
   * Sirve: POST /api/v1/ai/recommendations/generate
   * Autenticación: requerida.
   *
   * Cuerpo (`req.body`, validado con `generateRecommendationsSchema`; admite cuerpo vacío):
   * - `persist` (opcional): si es `true`, persiste las recomendaciones generadas.
   *
   * Usa `req.auth.tenantId` y `req.auth.userId` como contexto.
   *
   * Respuestas:
   * - 200: `{ success: true, persisted, recommendations, context }`.
   * - 400 VALIDATION_ERROR: el cuerpo no cumple el esquema.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 400 / 502: errores de dominio (VALIDATION_ERROR -> 400; resto -> 502).
   * - 500: error inesperado de generación de recomendaciones.
   */
  public generateRecommendations = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({
        success: false,
        error: 'Authentication is required',
        code: 'AUTHENTICATION_REQUIRED',
      });
      return;
    }

    const parsed = generateRecommendationsSchema.safeParse(req.body ?? {});

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid recommendation generation payload',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    try {
      const result = await this.aiService.generateRecommendations({
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        persist: parsed.data.persist === true,
        ...(parsed.data.externalResourceId !== undefined ? { externalResourceId: parsed.data.externalResourceId } : {}),
        ...(parsed.data.cloudResourceId !== undefined ? { cloudResourceId: parsed.data.cloudResourceId } : {}),
      });

      res.status(200).json({
        success: true,
        persisted: result.persisted,
        recommendations: result.recommendations,
        context: {
          periodStart: result.snapshot.periodStart,
          periodEnd: result.snapshot.periodEnd,
          totalCost: result.snapshot.totalCost,
          currency: result.snapshot.currency,
          metricCount: result.snapshot.metricCount,
        },
      });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'An unexpected AI recommendation error occurred', 'ai_operation_failed', req.path);
    }
  };

  /**
   * Devuelve el resumen de aprendizaje del agente para el tenant autenticado.
   *
   * Sirve: GET /api/v1/ai/learning/summary
   * Autenticación: requerida.
   *
   * Usa `req.auth.tenantId` como contexto.
   *
   * Respuestas:
   * - 200: `{ success: true, learning }`.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 503 LEARNING_NOT_CONFIGURED: el servicio de aprendizaje no está configurado.
   * - 400 / 502: errores de dominio (VALIDATION_ERROR -> 400; resto -> 502).
   * - 500: error inesperado del resumen de aprendizaje.
   */
  public getLearningSummary = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({
        success: false,
        error: 'Authentication is required',
        code: 'AUTHENTICATION_REQUIRED',
      });
      return;
    }

    if (this.learningService === undefined) {
      res.status(503).json({
        success: false,
        error: 'Learning service is not configured',
        code: 'LEARNING_NOT_CONFIGURED',
      });
      return;
    }

    try {
      const learning = await this.learningService.getLearningSummary(req.auth.tenantId);

      res.status(200).json({
        success: true,
        learning,
      });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'An unexpected AI learning summary error occurred', 'ai_operation_failed', req.path);
    }
  };

  /** Revierte una memoria activa sin borrar el evento que la originó. */
  public deactivateLearningMemory = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }
    const memoryId = typeof req.params['memoryId'] === 'string' ? req.params['memoryId'].trim() : '';
    if (memoryId === '') {
      res.status(400).json({ success: false, error: 'Memory id is required', code: 'VALIDATION_ERROR' });
      return;
    }
    if (this.learningService?.deactivateMemory === undefined) {
      res.status(503).json({ success: false, error: 'Learning memory rollback is not configured', code: 'LEARNING_NOT_CONFIGURED' });
      return;
    }
    try {
      const memory = await this.learningService.deactivateMemory(req.auth, memoryId);
      res.status(200).json({ success: true, memory });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible revertir la memoria del agente', 'ai_operation_failed', req.path);
    }
  };

}
