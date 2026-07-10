import type { Request, Response } from 'express';
import type { IAgentLearningService } from '../../../domain/interfaces/IAgentLearningService.js';
import type { IRecommendationRepository } from '../../../domain/interfaces/IRecommendationRepository.js';
import {
  parseDate,
  parseDecision,
  parseManualExecutionStatus,
  parseNumber,
  parseReasonCode,
  parseString,
  readBodyValue,
} from './recommendationRequestParsers.js';
import { requireAdminRole, requireAuth } from './recommendationRequestGuards.js';
import { respondWithRecommendationError } from './recommendationErrorResponse.js';

/**
 * Handlers de escritura gobernada (rol `ADMIN`) del controlador de
 * recomendaciones FinOps: registro de ejecuciones manuales y toma de decisiones
 * (aprobar/rechazar) sobre planes de ejecución, junto con el procesamiento
 * seguro del aprendizaje del agente.
 *
 * Se aíslan del controlador para mantenerlo enfocado en el enrutado HTTP. Cada
 * handler valida autenticación y rol, normaliza la entrada con los parsers
 * puros y delega la persistencia en el repositorio, mapeando los errores de
 * dominio a HTTP con {@link respondWithRecommendationError}.
 *
 * Importante: este módulo no importa desde el controlador, evitando
 * dependencias circulares.
 *
 * @module presentation/controllers/recommendation/recommendationDecisionHandlers
 */

/**
 * Registra una ejecución manual de una recomendación y responde con la ejecución
 * creada junto con la recomendación actualizada. Requiere autenticación y rol
 * `ADMIN`. Valida la presencia de `id`/`status` y que `observedMonthlySavings`
 * no sea negativo. Ver contrato HTTP en el handler homónimo del controlador.
 */
export async function handleCreateManualExecution(
  repository: IRecommendationRepository,
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const auth = requireAuth(req, res);
    if (auth === undefined) return;
    if (!requireAdminRole(res, auth)) return;

    const recommendationId = parseString(req.params['id']);
    const executionPlanId = parseString(readBodyValue(req.body, 'executionPlanId'));
    const status = parseManualExecutionStatus(readBodyValue(req.body, 'status'));
    const executedAt = parseDate(readBodyValue(req.body, 'executedAt'));
    const observedMonthlySavings = parseNumber(readBodyValue(req.body, 'observedMonthlySavings'));
    const currency = parseString(readBodyValue(req.body, 'currency')) ?? 'USD';
    const notes = parseString(readBodyValue(req.body, 'notes'));
    const evidence = readBodyValue(req.body, 'evidence');

    if (recommendationId === undefined || status === undefined) {
      res.status(400).json({
        success: false,
        error: 'Recommendation id and status are required',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    if (observedMonthlySavings !== undefined && observedMonthlySavings < 0) {
      res.status(400).json({
        success: false,
        error: 'Observed monthly savings cannot be negative',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const execution = await repository.createManualExecution({
      tenantId: auth.tenantId,
      recommendationId,
      ...(executionPlanId !== undefined ? { executionPlanId } : {}),
      userId: auth.userId,
      status,
      ...(executedAt !== undefined ? { executedAt } : {}),
      ...(observedMonthlySavings !== undefined ? { observedMonthlySavings } : {}),
      currency,
      ...(notes !== undefined ? { notes } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
    });

    const recommendation = await repository.findById(auth.tenantId, recommendationId);

    res.status(200).json({ success: true, execution, recommendation });
  } catch (error: unknown) {
    respondWithRecommendationError(res, error, 'An unexpected error occurred registering manual execution');
  }
}

/**
 * Registra una decisión (aprobar o rechazar) sobre el plan de ejecución de una
 * recomendación. Requiere autenticación y rol `ADMIN`. Valida los campos
 * obligatorios, exige motivo al rechazar, comprueba que el plan exista,
 * pertenezca a la recomendación y haya sido aprobado por la auditoría de IA, y
 * lanza el procesamiento de aprendizaje. Ver contrato HTTP en el handler
 * homónimo del controlador.
 */
export async function handleCreateDecision(
  repository: IRecommendationRepository,
  learningService: IAgentLearningService | undefined,
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const auth = requireAuth(req, res);
    if (auth === undefined) return;
    if (!requireAdminRole(res, auth)) return;

    const recommendationId = parseString(req.params['id']);
    const executionPlanId = parseString(readBodyValue(req.body, 'executionPlanId'));
    const decision = parseDecision(readBodyValue(req.body, 'decision'));
    const reasonCode = parseReasonCode(readBodyValue(req.body, 'reasonCode'));
    const reason = parseString(readBodyValue(req.body, 'reason'));

    if (
      recommendationId === undefined ||
      executionPlanId === undefined ||
      decision === undefined ||
      reasonCode === undefined
    ) {
      res.status(400).json({
        success: false,
        error: 'Recommendation id, executionPlanId, decision and reasonCode are required',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    if (decision === 'REJECTED' && reason === undefined) {
      res.status(400).json({
        success: false,
        error: 'A rejection reason is required',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const executionPlan = await repository.findExecutionPlanById(
      auth.tenantId,
      executionPlanId,
    );

    if (executionPlan === null || executionPlan.recommendationId !== recommendationId) {
      res.status(404).json({
        success: false,
        error: 'Execution plan not found',
        code: 'NOT_FOUND',
      });
      return;
    }

    if (executionPlan.auditVerdict !== 'APPROVED') {
      res.status(409).json({
        success: false,
        error: 'Execution plan was not approved by AI audit',
        code: 'AI_AUDIT_REJECTED',
      });
      return;
    }

    const decisionResult = await repository.createDecision({
      tenantId: auth.tenantId,
      recommendationId,
      executionPlanId,
      userId: auth.userId,
      decision,
      reasonCode,
      ...(reason !== undefined ? { reason } : {}),
    });

    const learning = await processLearningSafely(learningService, {
      tenantId: auth.tenantId,
      recommendationId,
      decisionId: decisionResult.decisionId,
      userId: auth.userId,
      decision,
      reasonCode,
      ...(reason !== undefined ? { reason } : {}),
    });

    res.status(200).json({
      success: true,
      recommendation: decisionResult.recommendation,
      executionPlan,
      learning,
    });
  } catch (error: unknown) {
    respondWithRecommendationError(res, error, 'An unexpected error occurred processing recommendation decision');
  }
}

/**
 * Procesa el aprendizaje del agente derivado de una decisión de forma segura
 * (sin propagar errores al flujo HTTP principal):
 * - Si el servicio de aprendizaje no está configurado, devuelve estado `PENDING`.
 * - Encola la decisión y, si obtiene `eventId`, lanza el procesamiento en
 *   segundo plano (los fallos solo se registran por consola).
 * - Ante cualquier excepción, devuelve estado `ERROR` con el mensaje.
 */
async function processLearningSafely(
  learningService: IAgentLearningService | undefined,
  input: Parameters<IAgentLearningService['processRecommendationDecision']>[0],
): Promise<Awaited<ReturnType<IAgentLearningService['processRecommendationDecision']>>> {
  if (learningService === undefined) {
    return {
      status: 'PENDING',
      error: 'Learning service is not configured',
    };
  }

  try {
    const queued = await learningService.queueRecommendationDecision(input);

    return queued;
  } catch (error: unknown) {
    return {
      status: 'ERROR',
      error: error instanceof Error ? error.message : 'Learning processing failed',
    };
  }
}
