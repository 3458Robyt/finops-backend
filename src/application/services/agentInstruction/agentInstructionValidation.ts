import type {
  AgentInstructionProfile,
  AgentInstructionRules,
  AgentInstructionValidationReport,
  TenantAgentRule,
} from '../../../domain/models/AgentContext.js';

/**
 * Validación y políticas de seguridad de las instrucciones del agente IA (TAK).
 *
 * Funciones puras (sin dependencias de framework, repositorio ni `this`) que
 * encapsulan la lista negra de patrones inseguros, la validación del perfil
 * global y de reglas de tenant, la detección de conflictos con el perfil global
 * y el perfil por defecto seguro. Se aíslan del servicio para mantenerlo
 * enfocado en los casos de uso y la autorización.
 *
 * @module application/services/agentInstruction/agentInstructionValidation
 */

/**
 * Patrones de texto considerados inseguros dentro de instrucciones del agente.
 *
 * Se usan como lista negra defensiva contra intentos de "prompt injection" o
 * de debilitar las garantías del sistema: desactivar la auditoría, eludir el
 * perfil global, prometer ejecución/remediación automática en la nube, o
 * incrustar secretos (credenciales, contraseñas, API keys, tokens).
 * Cualquier coincidencia invalida la instrucción.
 */
const forbiddenInstructionPatterns = [
  /ignora(r)?\s+(el\s+)?(sistema|auditor|perfil|instrucciones)/i,
  /sin\s+auditor(i|í)a/i,
  /ejecut(a|ar)\s+automaticamente/i,
  /remediaci(o|ó)n\s+autom(a|á)tica/i,
  /credencial|password|secreto|api\s*key|token/i,
];

/**
 * Valida un conjunto de reglas estructuradas del perfil global TAK.
 *
 * Reglas mínimas de negocio aplicadas:
 * - El objetivo debe tener al menos 20 caracteres (evita objetivos vacíos/ambiguos).
 * - Tono, política de riesgo y al menos una prioridad y un requisito de
 *   evidencia son obligatorios.
 * - El texto agregado del perfil no puede superar 8000 caracteres (control
 *   de tamaño/coste de prompt) y se somete al filtro de seguridad de texto libre.
 *
 * @param rules         - Reglas estructuradas a validar.
 * @param freeformNotes - Notas en texto libre opcionales, incluidas en la validación.
 * @returns Reporte con `passed`, problemas bloqueantes y advertencias.
 */
export function validateProfile(
  rules: AgentInstructionRules,
  freeformNotes: string | undefined,
): AgentInstructionValidationReport {
  const issues: string[] = [];
  const warnings: string[] = [];

  if (rules.objective.trim().length < 20) {
    issues.push('El objetivo del agente debe tener al menos 20 caracteres.');
  }

  if (rules.tone.trim() === '') {
    issues.push('El tono del agente es obligatorio.');
  }

  if (rules.recommendationPriorities.length === 0) {
    issues.push('Debe existir al menos una prioridad de recomendacion.');
  }

  if (rules.evidenceRequirements.length === 0) {
    issues.push('Debe existir al menos un requisito de evidencia.');
  }

  if (rules.riskPolicy.trim() === '') {
    issues.push('La politica de riesgo es obligatoria.');
  }

  const allText = [
    rules.objective,
    rules.tone,
    ...rules.recommendationPriorities,
    ...rules.evidenceRequirements,
    rules.riskPolicy,
    ...rules.forbiddenActions,
    freeformNotes ?? '',
  ].join('\n');
  const textValidation = validateFreeText(allText);

  issues.push(...textValidation.issues);
  warnings.push(...textValidation.warnings);

  if (allText.length > 8000) {
    issues.push('El perfil TAK no puede superar 8000 caracteres.');
  }

  return {
    passed: issues.length === 0,
    issues,
    warnings,
  };
}

/**
 * Aplica la lista negra de patrones inseguros sobre un texto libre.
 *
 * Heurística: si cualquier patrón de {@link forbiddenInstructionPatterns}
 * coincide, se emite un único mensaje de problema (deduplicado). Además,
 * textos de más de 4000 caracteres generan una advertencia por su posible
 * impacto en el consumo de tokens.
 *
 * @param text - Texto a inspeccionar.
 * @returns Problemas bloqueantes (sin duplicados) y advertencias.
 */
export function validateFreeText(text: string): { readonly issues: string[]; readonly warnings: string[] } {
  const issues = forbiddenInstructionPatterns
    .filter((pattern) => pattern.test(text))
    .map(() => 'La instruccion contiene contenido inseguro: no puede omitir auditoria, guardar secretos ni ejecutar remediacion automatica.');

  return {
    issues: [...new Set(issues)],
    warnings: text.length > 4000 ? ['La instruccion es extensa y puede aumentar consumo de tokens.'] : [],
  };
}

/**
 * Determina si una regla de tenant contradice el perfil global TAK.
 *
 * Heurística de conflicto:
 * - Menciones explícitas de operar "sin evidencia" se consideran contrarias
 *   al requisito de evidencia del perfil.
 * - Si el texto de la regla incluye alguna de las acciones prohibidas
 *   declaradas en el perfil (`forbiddenActions`), se marca como conflicto.
 *
 * @param ruleText - Texto de la regla del tenant.
 * @param profile  - Perfil global activo contra el que se compara.
 * @returns `true` si la regla contradice el perfil.
 */
export function contradictsGlobalTak(ruleText: string, profile: AgentInstructionProfile): boolean {
  const normalized = ruleText.toLowerCase();

  if (normalized.includes('no usar evidencia') || normalized.includes('sin evidencia')) {
    return true;
  }

  if (
    profile.structuredRules.forbiddenActions.some((action) => (
      action.trim() !== '' && normalized.includes(action.toLowerCase())
    ))
  ) {
    return true;
  }

  return false;
}

/**
 * Filtra reglas de tenant frente al perfil global, descartando las que
 * son inseguras o que contradicen el perfil TAK activo.
 *
 * Una regla se rechaza si su texto dispara {@link validateFreeText} o si
 * {@link contradictsGlobalTak} detecta conflicto con el perfil global.
 *
 * @param input - Tenant, perfil global activo y reglas candidatas.
 * @returns Reglas aceptadas y la lista de conflictos descriptivos de las
 *          reglas descartadas.
 */
export function filterRulesAgainstProfile(input: {
  readonly tenantId: string;
  readonly profile: AgentInstructionProfile;
  readonly rules: readonly TenantAgentRule[];
}): {
  readonly acceptedRules: readonly TenantAgentRule[];
  readonly conflicts: readonly string[];
} {
  const conflicts: string[] = [];
  const acceptedRules: TenantAgentRule[] = [];

  for (const rule of input.rules) {
    const validation = validateFreeText(rule.ruleText);
    const contradictsProfile = contradictsGlobalTak(rule.ruleText, input.profile);

    if (validation.issues.length > 0 || contradictsProfile) {
      conflicts.push(`Regla ${rule.id} ignorada: contradice el perfil global TAK o las restricciones de auditoria.`);
    } else {
      acceptedRules.push(rule);
    }
  }

  return { acceptedRules, conflicts };
}

/**
 * Perfil de instrucciones por defecto, seguro y conservador.
 *
 * Se usa como respaldo cuando no hay un perfil activo persistido. Codifica
 * las garantías base del agente: respuestas en español, accionables y
 * auditables, prohibición de remediación automática y de inferir métricas
 * técnicas (CPU, memoria, IOPS, throughput) a partir de datos FOCUS.
 * Versión 0 y marcas de tiempo en epoch para señalar su origen sintético.
 */
export function defaultProfile(): AgentInstructionProfile {
  const now = new Date(0);

  return {
    id: 'default-tak-profile',
    version: 0,
    status: 'ACTIVE',
    structuredRules: {
      objective: 'Generar recomendaciones FinOps en espanol, accionables, auditables y basadas en evidencia real.',
      tone: 'Profesional, claro, prudente y orientado a operaciones.',
      recommendationPriorities: [
        'Priorizar ahorro verificable y bajo riesgo operativo.',
        'Explicar limites de evidencia cuando solo existan datos FOCUS.',
        'No recomendar cambios tecnicos fuertes sin metricas tecnicas suficientes.',
      ],
      evidenceRequirements: [
        'Usar costos, consumo facturado, cuenta, servicio y recurso cuando esten disponibles.',
        'Declarar si la recomendacion requiere validacion tecnica adicional.',
      ],
      riskPolicy: 'No prometer remediacion automatica; toda ejecucion debe ser manual, gobernada y reversible.',
      forbiddenActions: [
        'ejecutar automaticamente cambios cloud',
        'ignorar auditoria',
        'inventar recursos',
        'inferir CPU, memoria, IOPS o throughput desde FOCUS',
      ],
    },
    createdByUserId: 'system',
    createdAt: now,
    updatedAt: now,
  };
}
