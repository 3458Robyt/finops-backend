import type { UserRole } from './AuthContext.js';

/**
 * Estado del ciclo de vida de un perfil de instrucciones del agente de IA.
 *
 * - `DRAFT`: Borrador en edición, aún no validado ni activo.
 * - `ACTIVE`: Perfil vigente que rige el comportamiento del agente.
 * - `ARCHIVED`: Versión anterior conservada como histórico, ya no vigente.
 * - `REJECTED`: Perfil descartado durante la validación.
 */
export type AgentInstructionProfileStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED' | 'REJECTED';

/**
 * Estado de una regla de agente específica del tenant.
 *
 * - `ACTIVE`: La regla se aplica al construir el contexto del agente.
 * - `DISABLED`: La regla está deshabilitada y se ignora.
 */
export type TenantAgentRuleStatus = 'ACTIVE' | 'DISABLED';

/**
 * Tipo de operación de IA para la que se construye o traza el contexto.
 *
 * - `CHAT`: Conversación interactiva con el usuario.
 * - `RECOMMENDATION`: Generación de recomendaciones FinOps.
 * - `EXECUTION_PLAN`: Elaboración de un plan de ejecución de una recomendación.
 * - `AUDIT`: Auditoría/validación de salidas generadas por IA.
 * - `LEARNING`: Procesos de aprendizaje y memorización del agente.
 */
export type AiContextOperation = 'CHAT' | 'RECOMMENDATION' | 'EXECUTION_PLAN' | 'AUDIT' | 'LEARNING';

/**
 * Estado de una ejecución de construcción de contexto del agente.
 *
 * - `PENDING`: Encolada, pendiente de iniciar.
 * - `RUNNING`: En ejecución.
 * - `SUCCESS`: Finalizada correctamente.
 * - `FAILED`: Finalizada con error.
 */
export type ContextBuildRunStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';

/**
 * Conjunto estructurado de reglas que definen el comportamiento esperado del
 * agente de IA. Forma el núcleo de un {@link AgentInstructionProfile}.
 */
export interface AgentInstructionRules {
  /** Objetivo principal que debe perseguir el agente. */
  readonly objective: string;
  /** Tono comunicativo que debe emplear el agente (e.g., formal, conciso). */
  readonly tone: string;
  /** Prioridades a la hora de ordenar/seleccionar recomendaciones, en orden de importancia. */
  readonly recommendationPriorities: readonly string[];
  /** Requisitos de evidencia que toda recomendación debe satisfacer antes de proponerse. */
  readonly evidenceRequirements: readonly string[];
  /** Política de gestión de riesgo que el agente debe respetar. */
  readonly riskPolicy: string;
  /** Acciones explícitamente prohibidas para el agente. */
  readonly forbiddenActions: readonly string[];
}

/**
 * Perfil versionado de instrucciones que gobierna el comportamiento del agente
 * de IA. Cada cambio relevante produce una nueva versión; solo una suele estar
 * en estado `ACTIVE` a la vez.
 */
export interface AgentInstructionProfile {
  /** Identificador único del perfil. */
  readonly id: string;
  /** Número de versión incremental del perfil. */
  readonly version: number;
  /** Estado del ciclo de vida del perfil. */
  readonly status: AgentInstructionProfileStatus;
  /** Reglas estructuradas que componen el perfil. */
  readonly structuredRules: AgentInstructionRules;
  /** Notas en texto libre que complementan las reglas estructuradas. */
  readonly freeformNotes?: string | undefined;
  /** Informe de validación asociado a esta versión, si se ha ejecutado. */
  readonly validationReport?: AgentInstructionValidationReport | undefined;
  /** Fecha de activación del perfil (cuando pasó a `ACTIVE`). */
  readonly activatedAt?: Date | undefined;
  /** Identificador del usuario que creó el perfil. */
  readonly createdByUserId: string;
  /** Identificador del usuario que activó el perfil, si aplica. */
  readonly activatedByUserId?: string | undefined;
  /** Fecha de creación del registro. */
  readonly createdAt: Date;
  /** Fecha de la última actualización del registro. */
  readonly updatedAt: Date;
}

/**
 * Resultado de validar un {@link AgentInstructionProfile}, indicando si supera
 * los controles y qué problemas o advertencias se detectaron.
 */
export interface AgentInstructionValidationReport {
  /** `true` si el perfil supera la validación sin problemas bloqueantes. */
  readonly passed: boolean;
  /** Problemas detectados que impiden la activación del perfil. */
  readonly issues: readonly string[];
  /** Advertencias no bloqueantes que conviene revisar. */
  readonly warnings: readonly string[];
}

/**
 * Regla de comportamiento del agente definida a nivel de tenant, que permite
 * personalizar el agente para un cliente concreto sin alterar el perfil base.
 */
export interface TenantAgentRule {
  /** Identificador único de la regla. */
  readonly id: string;
  /** Tenant (cliente) al que pertenece la regla. */
  readonly tenantId: string;
  /** Categoría o agrupación temática de la regla. */
  readonly category: string;
  /** Texto de la regla, en lenguaje natural. */
  readonly ruleText: string;
  /** Prioridad de aplicación; valores mayores tienen más peso al resolver conflictos. */
  readonly priority: number;
  /** Estado de la regla (activa o deshabilitada). */
  readonly status: TenantAgentRuleStatus;
  /** Fecha en la que la regla fue deshabilitada, si aplica. */
  readonly disabledAt?: Date | undefined;
  /** Identificador del usuario que creó la regla. */
  readonly createdByUserId: string;
  /** Fecha de creación del registro. */
  readonly createdAt: Date;
  /** Fecha de la última actualización del registro. */
  readonly updatedAt: Date;
}

/**
 * Fragmento de contexto (artefacto) que se incorpora al prompt del agente,
 * resumiendo información relevante de una entidad o ámbito concreto.
 */
export interface ContextArtifact {
  /** Identificador único del artefacto. */
  readonly id: string;
  /** Tipo de artefacto (e.g., resumen de costos, inventario, métrica). */
  readonly artifactType: string;
  /** Clave del ámbito al que aplica el artefacto (identifica el alcance del resumen). */
  readonly scopeKey: string;
  /** Resumen textual del contenido del artefacto, listo para inyectar en el prompt. */
  readonly summary: string;
  /** Estimación de tokens que consume el artefacto al incluirse en el prompt. */
  readonly tokenEstimate: number;
  /** Código del proveedor cloud asociado, si aplica. */
  readonly provider?: string | undefined;
  /** Identificador de la cuenta cloud asociada, si aplica. */
  readonly cloudAccountId?: string | undefined;
  /** Nombre del servicio cloud asociado, si aplica. */
  readonly serviceName?: string | undefined;
  /** Identificador del recurso asociado, si aplica. */
  readonly resourceId?: string | undefined;
  /** Referencias a la evidencia de soporte (estructura libre). */
  readonly evidenceRefs?: unknown | undefined;
}

/**
 * Traza de auditoría de una invocación de IA, que registra metadatos de la
 * operación para observabilidad, control de costos de tokens y depuración.
 */
export interface AiContextTrace {
  /** Identificador único de la traza. */
  readonly id: string;
  /** Tenant (cliente) al que pertenece la operación. */
  readonly tenantId: string;
  /** Usuario que originó la operación, si aplica. */
  readonly userId?: string | undefined;
  /** Tipo de operación de IA trazada. */
  readonly operation: AiContextOperation;
  /** Identificador del modelo de IA utilizado. */
  readonly model: string;
  /** Estado resultante de la operación. */
  readonly status: string;
  /** Versión del perfil de instrucciones aplicado, si aplica. */
  readonly profileVersion?: number | undefined;
  /** Estimación de tokens del prompt enviado. */
  readonly promptTokenEstimate: number;
  /** Estimación de tokens de la respuesta recibida, si aplica. */
  readonly responseTokenEstimate?: number | undefined;
  /** Latencia de la operación en milisegundos, si se midió. */
  readonly latencyMs?: number | undefined;
  /** Fecha de creación de la traza. */
  readonly createdAt: Date;
  /** Fecha de expiración de la traza (para retención/limpieza). */
  readonly expiresAt: Date;
}

/**
 * Roles con permisos de administración del agente (gestión de perfiles y reglas).
 * Se usa para autorizar operaciones administrativas sobre el agente.
 */
export const agentAdminRoles: readonly UserRole[] = ['ADMIN', 'MASTER_ADMIN', 'OPERATOR_ADMIN'];

/**
 * Roles con permisos técnicos sobre el agente (operaciones técnicas además de las
 * administrativas). Incluye al técnico FinOps junto a los roles administrativos.
 */
export const agentTechnicalRoles: readonly UserRole[] = ['ADMIN', 'MASTER_ADMIN', 'OPERATOR_ADMIN', 'FINOPS_TECHNICIAN'];
