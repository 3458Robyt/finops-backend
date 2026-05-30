import { FinOpsBaseError } from '../../../domain/errors/errors.js';
import type { AiAuditReport } from '../../../domain/models/RecommendationExecutionPlan.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Parser de reportes de auditoría de aprendizaje IA
 * ═══════════════════════════════════════════════════════════════
 *
 * Funciones puras que extraen y validan la respuesta del modelo auditor de
 * aprendizaje (texto JSON, posiblemente con cercos Markdown) hacia un
 * {@link AiAuditReport} seguro, y que clasifican los fallos del servicio IA
 * como externos/transitorios frente a errores de lógica. Centralizarlas aquí
 * mantiene el servicio enfocado en la orquestación del caso de uso.
 *
 * @module application/services/learning/learningAuditParser
 */

/**
 * Parsea y valida la respuesta del auditor IA a un {@link AiAuditReport}.
 *
 * Extrae el JSON (tolerando bloques de código) y verifica que `verdict` sea
 * uno de `APPROVED`/`REJECTED`/`NEEDS_REVISION` y que `score` sea numérico.
 * Normaliza `checks`, `blockingIssues` y `requiredChanges` a formas seguras.
 *
 * @throws {FinOpsBaseError} Con código `AI_RESPONSE_ERROR` si la respuesta no es
 *         un objeto válido o le faltan campos obligatorios.
 */
export function parseAuditReport(rawResponse: string): AiAuditReport {
  const json = extractJson(rawResponse);
  const parsed = JSON.parse(json) as unknown;

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FinOpsBaseError('AI auditor did not return a valid learning audit', 'AI_RESPONSE_ERROR');
  }

  const record = parsed as Record<string, unknown>;
  const verdict = record['verdict'];
  const score = record['score'];

  if (
    (verdict !== 'APPROVED' && verdict !== 'REJECTED' && verdict !== 'NEEDS_REVISION') ||
    typeof score !== 'number'
  ) {
    throw new FinOpsBaseError('AI auditor did not return a complete learning audit', 'AI_RESPONSE_ERROR');
  }

  return {
    verdict,
    score,
    checks: Array.isArray(record['checks']) ? record['checks'] as AiAuditReport['checks'] : [],
    blockingIssues: Array.isArray(record['blockingIssues'])
      ? record['blockingIssues'].filter((item): item is string => typeof item === 'string')
      : [],
    requiredChanges: Array.isArray(record['requiredChanges'])
      ? record['requiredChanges'].filter((item): item is string => typeof item === 'string')
      : [],
  };
}

/**
 * Determina si un error corresponde a un fallo externo/transitorio del
 * servicio IA (que debe tratarse como `SKIPPED`) en lugar de un error de
 * lógica (`ERROR`).
 *
 * Heurística: se consideran externos los `FinOpsBaseError` con código
 * `AI_RESPONSE_ERROR` y los mensajes que contienen señales de timeout,
 * límite de tasa, indisponibilidad del servicio, errores de gateway o de JSON.
 */
export function isExternalAiLearningFailure(error: unknown): boolean {
  if (error instanceof FinOpsBaseError && error.code === 'AI_RESPONSE_ERROR') {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  return message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('rate limit') ||
    message.includes('service unavailable') ||
    message.includes('bad gateway') ||
    message.includes('gateway') ||
    message.includes('json');
}

/**
 * Extrae el cuerpo JSON de una respuesta de IA, tolerando que venga
 * envuelto en un bloque de código Markdown (```json ... ```). Si no hay
 * cerco, devuelve el texto recortado tal cual.
 */
export function extractJson(value: string): string {
  const trimmed = value.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);

  if (fenced?.[1] !== undefined) {
    return fenced[1];
  }

  return trimmed;
}
