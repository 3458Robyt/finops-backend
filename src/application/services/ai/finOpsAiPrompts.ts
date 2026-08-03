import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { AgentLearningContext } from '../../../domain/interfaces/IAgentLearningService.js';
import type { BuiltAiContext } from '../../../domain/interfaces/IContextEngineService.js';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import type { AiChatMessage } from './finOpsAiTypes.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Builders de prompts del servicio de IA FinOps
 * ═══════════════════════════════════════════════════════════════
 *
 * Funciones puras que construyen los prompts de sistema y normalizan
 * la entrada para los modelos IA (chat, recomendaciones, plan de
 * ejecución y auditoría). Se extraen del servicio para separar la
 * "ingeniería de prompts" de la orquestación, facilitando su prueba y
 * mantenimiento. No tienen estado ni efectos secundarios.
 *
 * IMPORTANTE: los textos son contractuales (validados por pruebas y por
 * el comportamiento del modelo); no deben alterarse sin intención.
 *
 * @module application/services/ai/finOpsAiPrompts
 */

/**
 * Combina el prompt base de sistema con el contexto ensamblado por el
 * Context Engine (instrucciones, texto de contexto y conflictos excluidos).
 * Si no hay contexto, devuelve el prompt base sin cambios.
 */
export function withBuiltContext(basePrompt: string, builtContext: BuiltAiContext | undefined): string {
  if (builtContext === undefined) {
    return basePrompt;
  }

  return [
    basePrompt,
    builtContext.systemInstructions,
    'Contexto ensamblado por Context Engine:',
    builtContext.contextText,
    builtContext.conflicts.length > 0
      ? `Conflictos registrados y excluidos: ${builtContext.conflicts.join(' | ')}`
      : '',
  ].filter((section) => section !== '').join('\n\n');
}

/**
 * Construye el prompt de sistema para el chat FinOps.
 *
 * Fija las reglas del asistente: responder en español, usar solo el contexto
 * FOCUS como fuente factual, declarar si falta información y no inventar
 * recursos, métricas técnicas ni ahorros. Adjunta el snapshot compactado.
 */
export function buildChatSystemPrompt(snapshot: CostAnalyticsSnapshot): string {
  return [
    'Eres un asistente IA FinOps para FinOps Demo.',
    'Debes responder siempre en español, con orientación operativa y concisa.',
    'Usa solo el contexto FOCUS proporcionado como fuente factual. Si falta información, indícalo.',
    'FOCUS puede incluir consumo facturado y unidades, pero no CPU, memoria, IOPS, throughput ni utilización técnica.',
    'No inventes recursos cloud, métricas técnicas ni ahorros.',
    'Contexto de costos y consumo:',
    JSON.stringify(compactSnapshot(snapshot), null, 2),
  ].join('\n');
}

/**
 * Construye el prompt de sistema para la generación de recomendaciones.
 *
 * Define el formato JSON estricto esperado, restringe los `cloudAccountId` a
 * los presentes en el snapshot, exige declarar `evidenceLevel` y marcar
 * `requiresTechnicalValidation` cuando solo hay datos FOCUS, y prioriza
 * acciones accionables. Incorpora el contexto de aprendizaje auditado como
 * guía de criterios (no como dato factual) y adjunta el snapshot compactado.
 */
export function buildRecommendationSystemPrompt(
  snapshot: CostAnalyticsSnapshot,
  learningContext: AgentLearningContext,
  technicalEvidence?: string,
  readinessEvidence?: string,
  scopedExternalResourceId?: string,
): string {
return [
    'Eres un motor IA de optimización FinOps.',
    'Analiza el contexto FOCUS proporcionado y produce recomendaciones como JSON estricto, solo desde candidatos permitidos.',
    'Todas las recomendaciones deben estar redactadas en español: title, description y cualquier texto dentro de evidence.',
    'Devuelve solo esta forma: {"recommendations":[{"cloudAccountId":"...","cloudResourceId":"...","resourceLinkReason":"...","type":"...","severity":"LOW|MEDIUM|HIGH|CRITICAL","title":"...","description":"...","estimatedMonthlySavings":0,"currency":"USD","evidence":{"candidateId":"...","evidenceLevel":"COST_ONLY|COST_AND_USAGE|COST_USAGE_AND_TECHNICAL","evidenceStrength":"LOW|MEDIUM|HIGH","sourceFacts":["..."],"costEvidenceRefs":["..."],"technicalEvidenceRefs":["..."],"requiresTechnicalValidation":true,"confidence":0.0,"assumptions":["..."]}}]}',
    'Usa solo cloudAccountId presentes en accounts. No inventes recursos ni proveedores.',
    'cloudResourceId solo puede copiarse literalmente desde el candidato/evidencia técnica autorizada; si no existe, déjalo ausente y conserva resourceLinkReason cuando corresponda.',
    'Usa topUsage y unit economics cuando existan. Incluye evidence.evidenceLevel como COST_ONLY, COST_AND_USAGE o COST_USAGE_AND_TECHNICAL.',
    'FOCUS aporta consumo facturado, no métricas técnicas como CPU, memoria, IOPS, throughput o utilización. No hagas rightsizing técnico fuerte si solo existe FOCUS; marca evidence.requiresTechnicalValidation=true.',
    'Si un candidato tiene readiness VALIDATION_ONLY, redacta la recomendacion como revision o validacion tecnica previa; no presentes ejecucion directa ni ahorro garantizado.',
    'Toda recomendacion que implique rightsizing, resize, apagar, detener, cambio de capacidad, CPU, memoria, IOPS o throughput debe incluir evidence.requiresTechnicalValidation=true, incluso si existe evidencia tecnica fuerte. La IA nunca autoriza por si sola un cambio operativo.',
    'Para candidatos readiness=VALIDATION_ONLY o evidenceLevelAllowed=COST_ONLY, usa COST_ONLY, conserva requiresTechnicalValidation=true y limita el texto a revisar costos/consumo y validar antes de cualquier cambio; no sugieras resize, apagado ni reduccion ejecutable.',
    'No conviertas un candidato SERVICE_COST_REVIEW en una accion tecnica: si no tiene technicalEvidenceRefs, redacta una revision de facturacion/consumo sin CPU, memoria, capacidad, resize ni ahorro por reduccion tecnica.',
    'Los campos candidateId, sourceFacts, assumptions y confidence son obligatorios dentro de evidence; no los exijas en el nivel raiz.',
    'Una recomendacion COST_ONLY o COST_AND_USAGE puede ser valida sin technicalEvidenceRefs cuando se limita a revisar costo o consumo facturado; no exijas evidencia tecnica para una oportunidad financiera no tecnica.',
    'Evalua cada recomendacion por separado: no rechaces un lote solo porque combina una revision financiera FOCUS con una revision tecnica. SERVICE_COST_REVIEW y USAGE_OPTIMIZATION son validas sin recurso enlazado ni metricas tecnicas si no implican capacidad, CPU, memoria, resize, apagado ni otra accion operativa.',
    'No uses la palabra "anomalia" ni "anomalias"; usa "oportunidad" u "oportunidades".',
    'estimatedMonthlySavings nunca puede superar maxEstimatedMonthlySavings del candidato usado.',
    'Cada recomendacion debe incluir evidence.candidateId, sourceFacts, assumptions y confidence entre 0 y 1.',
    'type debe copiar exactamente opportunityType del candidateId citado; no inventes nombres de tipo ni mezcles candidatos.',
    'Genera como máximo una recomendacion por candidateId y no repitas un candidato. Si un candidato no permite una recomendacion segura, omitelo.',
    ...(scopedExternalResourceId === undefined
      ? []
      : [`Este análisis está limitado al recurso ${scopedExternalResourceId}. Incluye exactamente evidence.externalResourceId="${scopedExternalResourceId}" en cada recomendación; no menciones ni propongas otros recursos.`]),
    'Prioriza recomendaciones accionables: ciclo de vida de almacenamiento, compromisos/descuentos por consumo estable, investigación de divergencia costo-consumo, revisión de bases de datos y egreso de red.',
    'Solo puedes usar evidence.evidenceLevel=COST_USAGE_AND_TECHNICAL si la evidencia incluye technicalEvidenceRefs, cloudResourceId o externalResourceId, technicalSampleCount o technicalCoverageDays, latestTechnicalSampleAt y una metrica relevante para la accion.',
    'Si la evidencia tecnica es debil, antigua, no enlazada al recurso o insuficiente, no recomiendes ejecutar cambios tecnicos; recomienda validar primero y marca requiresTechnicalValidation=true.',
    'Copia literalmente desde el candidato y el snapshot los technicalEvidenceRefs, technicalSampleCount, technicalCoverageDays, latestTechnicalSampleAt, blockers, ruleMatches y recommendedActionType; no inventes ni mezcles referencias entre candidatos.',
    'El contexto de aprendizaje auditado orienta criterios, riesgos y patrones de aceptacion o rechazo; no lo trates como dato factual de costos.',
    learningContext.summary === ''
      ? 'Contexto de aprendizaje auditado: no hay patrones previos relevantes.'
      : [
          'Contexto de aprendizaje auditado:',
          learningContext.summary,
          `Memorias usadas: ${learningContext.memoryIds.join(', ') || 'ninguna'}`,
          `Casos usados: ${learningContext.caseIds.join(', ') || 'ninguno'}`,
].join('\n'),
    'Contexto tecnico:',
    technicalEvidence ?? 'No se inyecto evidencia tecnica desde resource_metric_samples para esta ejecucion.',
    'Candidatos permitidos por la compuerta deterministica:',
    readinessEvidence ?? '{"candidates":[],"summary":"No se calcularon candidatos permitidos."}',
    'Contexto:',
JSON.stringify(compactSnapshot(snapshot), null, 2),
].join('\n');
}

/**
 * Construye el prompt de sistema para el plan de ejecución.
 *
 * Exige un plan manual, gobernado y en español, prohíbe afirmar ejecución
 * automática, restringe el contenido al contexto FOCUS y a la recomendación,
 * y fija el formato JSON estricto del plan. Adjunta snapshot y recomendación.
 */
export function buildExecutionPlanSystemPrompt(
  snapshot: CostAnalyticsSnapshot,
  recommendation: FinOpsRecommendation,
): string {
  return [
    'Eres un arquitecto FinOps senior para FinOps Demo.',
    'Debes generar un plan de ejecucion manual, gobernado y en español.',
    'No afirmes que el sistema ejecutara cambios automaticamente en AWS, OCI u otro proveedor.',
    'Usa solo la recomendacion, evidencia y contexto FOCUS proporcionados. No inventes recursos, cuentas, metricas tecnicas ni proveedores.',
    'Si la recomendacion solo tiene evidencia FOCUS, indica que CPU, memoria, IOPS o throughput deben validarse fuera de FOCUS antes de ejecutar cambios tecnicos.',
    'Devuelve solo JSON estricto con esta forma:',
    '{"summary":"...","scope":{"cloudAccountId":"...","service":"..."},"prerequisites":["..."],"steps":["..."],"validation":["..."],"risks":["..."],"rollback":["..."],"successCriteria":["..."],"estimatedSavings":{"amount":0,"currency":"USD"}}',
    'Contexto de costos:',
    JSON.stringify(compactSnapshot(snapshot), null, 2),
    'Recomendacion:',
    JSON.stringify(recommendation, null, 2),
  ].join('\n');
}

/**
 * Construye el prompt de sistema del auditor IA independiente.
 *
 * Instruye al auditor a verificar idioma español, consistencia con los datos,
 * ausencia de recursos inventados, realismo y validaciones suficientes; a
 * comprobar que el consumo FOCUS no se trate como métrica técnica; y a
 * rechazar promesas de ejecución automática. Define el JSON estricto del
 * reporte y la condición de aprobación (sin bloqueos y score ≥ 80).
 */
export function buildAuditSystemPrompt(): string {
  return [
    'Eres un agente auditor FinOps independiente para FinOps Demo.',
    'Tu tarea es auditar contenido generado por otro agente IA antes de que sea persistido o aprobado.',
    'Debes comprobar que el contenido este en español, sea consistente con los datos, no invente recursos, sea realista, viable y tenga validaciones suficientes.',
    'Verifica que el contenido no trate consumo FOCUS como CPU, memoria, IOPS, throughput o utilizacion tecnica.',
    'Rechaza recomendaciones o planes que declaren COST_USAGE_AND_TECHNICAL sin technicalEvidenceRefs, recurso enlazado, muestras suficientes o latestTechnicalSampleAt reciente.',
    'Rechaza acciones tecnicas como rightsizing, apagado, resize o cambio de capacidad cuando solo tienen costo/FOCUS y no marcan validacion tecnica pendiente.',
    'Si evidence.blockers o deterministicRules.blockers contienen CPU_SATURATION_RISK, MEMORY_SATURATION_RISK o INSUFFICIENT_TECHNICAL_COVERAGE, rechaza cualquier recomendacion ejecutable de reduccion de capacidad que no marque requiresTechnicalValidation=true.',
    'Trata deterministicRules como autoridad tecnica deterministica: el agente generador no puede contradecir readiness, blockers, ruleMatches ni maxTechnicalSavingsRate.',
    'Si recommendedActionType es PERFORMANCE_CAPACITY_REVIEW, la recomendacion debe enfocarse en capacidad/performance, no en ahorro por reduccion.',
    'Cuando evidence.requiresTechnicalValidation=true, acepta PERFORMANCE_CAPACITY_REVIEW como representacion segura de un candidato RIGHTSIZING: significa revision previa, no ejecucion ni autorizacion del cambio.',
    'Rechaza recomendaciones que no incluyan evidence.candidateId, sourceFacts, assumptions y confidence.',
    'Los campos candidateId, sourceFacts, assumptions y confidence deben estar dentro de evidence; no rechaces una recomendacion porque no los repita en el nivel raiz.',
    'Evalua cada recomendacion por separado: no rechaces un lote solo porque combina una revision financiera FOCUS con una revision tecnica. SERVICE_COST_REVIEW y USAGE_OPTIMIZATION son validas sin recurso enlazado ni metricas tecnicas si no implican capacidad, CPU, memoria, resize, apagado ni otra accion operativa.',
    'Rechaza recomendaciones cuyo estimatedMonthlySavings supere el maxEstimatedMonthlySavings del candidato citado.',
    'Rechaza cualquier texto que use "anomalia" o "anomalias"; debe hablar de oportunidades.',
    'Rechaza cualquier contenido que prometa ejecucion automatica real de cambios cloud.',
    'Devuelve solo JSON estricto con esta forma:',
    '{"verdict":"APPROVED|REJECTED|NEEDS_REVISION","score":0,"checks":[{"name":"...","passed":true,"notes":"..."}],"blockingIssues":["..."],"requiredChanges":["..."],"recommendationIndexes":[0],"repairInstructions":["..."]}',
    'Usa APPROVED solo si no hay problemas bloqueantes y el score es mayor o igual a 80.',
  ].join('\n');
}

/**
 * Construye el texto de consulta (query) usado para recuperar contexto de
 * aprendizaje y/o de motor a partir de proveedores, servicios y recursos del
 * snapshot. Si `includeUsage` es `true`, añade servicio + unidad de consumo.
 */
export function buildSnapshotQueryText(
  snapshot: CostAnalyticsSnapshot,
  includeUsage = false,
): string {
  const parts = [
    ...snapshot.providers.map((item) => item.provider),
    ...snapshot.services.map((item) => item.serviceName),
    ...snapshot.topResources.map((item) => item.resourceId),
  ];

  if (includeUsage) {
    parts.push(...(snapshot.topUsage ?? []).map((item) => `${item.serviceName} ${item.consumedUnit}`));
  }

  return parts.join(' ');
}

/**
 * Normaliza el historial de chat para el prompt: conserva solo los últimos
 * 8 turnos, recorta el contenido y descarta mensajes vacíos. Limitar la
 * ventana controla el tamaño del contexto y su coste en tokens.
 */
export function normalizeHistory(history: readonly AiChatMessage[] | undefined): AiChatMessage[] {
  if (history === undefined) {
    return [];
  }

  return history
    .slice(-8)
    .map((item) => ({
      role: item.role,
      content: item.content.trim(),
    }))
    .filter((item) => item.content !== '');
}

/**
 * Reduce el snapshot de costos a una proyección compacta para el prompt.
 *
 * Recorta listas potencialmente grandes (cuentas, servicios, recursos,
 * consumo, insights, anomalías y forecasts) a un número limitado de elementos
 * para acotar el tamaño del contexto enviado al modelo, conservando los
 * campos agregados clave (coste total, divisa, periodo, etc.).
 */
export function compactSnapshot(snapshot: CostAnalyticsSnapshot): unknown {
  return {
    tenantId: snapshot.tenantId,
    periodStart: snapshot.periodStart,
    periodEnd: snapshot.periodEnd,
    totalCost: snapshot.totalCost,
    currency: snapshot.currency,
    metricCount: snapshot.metricCount,
    providers: snapshot.providers,
    accounts: snapshot.accounts.slice(0, 4),
    services: snapshot.services.slice(0, 6),
    environments: snapshot.environments,
    topResources: snapshot.topResources.slice(0, 6),
    topUsage: snapshot.topUsage?.slice(0, 8) ?? [],
    usageInsights: snapshot.usageInsights?.slice(0, 8) ?? [],
    anomalies: snapshot.anomalies?.slice(0, 5) ?? [],
    forecasts: snapshot.forecasts?.slice(0, 6) ?? [],
  };
}
