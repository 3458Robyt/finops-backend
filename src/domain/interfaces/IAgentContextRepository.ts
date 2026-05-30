import type {
  AgentInstructionProfile,
  AgentInstructionRules,
  AgentInstructionValidationReport,
  AiContextOperation,
  AiContextTrace,
  ContextArtifact,
  ContextBuildRunStatus,
  KnowledgeGraphContext,
  TenantAgentRule,
} from '../models/AgentContext.js';
import type { AgentMemoryScope } from '../models/AgentLearning.js';

/**
 * Datos de entrada para activar un perfil de instrucciones del agente.
 *
 * Al activarse, el perfil pasa a regir el comportamiento del agente; incluye las
 * reglas estructuradas, notas libres y el informe de validación que lo respalda.
 */
export interface ActivateAgentProfileInput {
  /** Usuario que ejecuta la activación; usado para auditoría. */
  readonly actorUserId: string;
  /** Reglas estructuradas que componen el perfil de instrucciones. */
  readonly structuredRules: AgentInstructionRules;
  /** Notas en texto libre complementarias; opcional. */
  readonly freeformNotes?: string;
  /** Informe de validación que verifica la consistencia del perfil. */
  readonly validationReport: AgentInstructionValidationReport;
}

/**
 * Datos de entrada para crear una regla de agente específica de un tenant.
 */
export interface CreateTenantAgentRuleInput {
  readonly tenantId: string;
  /** Categoría temática de la regla. */
  readonly category: string;
  /** Texto de la regla. */
  readonly ruleText: string;
  /** Prioridad de la regla; valores mayores tienen precedencia ante conflictos. */
  readonly priority: number;
  readonly createdByUserId: string;
}

/**
 * Datos de entrada para insertar o actualizar (upsert) un resumen de contexto.
 *
 * Los resúmenes son artefactos pre-computados que condensan datos de costo para
 * su uso eficiente en el contexto de la IA. La deduplicación se basa en
 * `scopeKey` + `sourceHash`.
 */
export interface UpsertContextSummaryInput {
  readonly tenantId: string;
  /** Tipo de artefacto de contexto. */
  readonly artifactType: string;
  /** Clave de alcance que identifica el ámbito del resumen. */
  readonly scopeKey: string;
  /** Hash de la fuente; permite detectar si el resumen está desactualizado. */
  readonly sourceHash: string;
  /** Texto del resumen. */
  readonly summary: string;
  /** Estimación de tokens del resumen, para control de presupuesto de contexto. */
  readonly tokenEstimate: number;
  readonly provider?: string;
  readonly cloudAccountId?: string;
  readonly serviceName?: string;
  readonly resourceId?: string;
  /** Inicio del periodo cubierto por el resumen; opcional. */
  readonly periodStart?: Date;
  /** Fin del periodo cubierto por el resumen; opcional. */
  readonly periodEnd?: Date;
  /** Hechos estructurados extraídos; opcional. */
  readonly facts?: unknown;
  /** Referencias a la evidencia que respalda el resumen; opcional. */
  readonly evidenceRefs?: unknown;
}

/**
 * Datos de entrada para registrar una traza de uso de contexto de IA.
 *
 * Cada traza documenta una invocación al modelo y las fuentes de contexto
 * empleadas, sirviendo de base para observabilidad y costos.
 */
export interface CreateAiContextTraceInput {
  readonly tenantId: string;
  readonly userId?: string;
  /** Operación de IA que generó la traza. */
  readonly operation: AiContextOperation;
  /** Modelo utilizado. */
  readonly model: string;
  /** Estado del resultado de la invocación. */
  readonly status: string;
  /** Versión del perfil de instrucciones aplicado; opcional. */
  readonly profileVersion?: number;
  /** Estimación de tokens del prompt enviado. */
  readonly promptTokenEstimate: number;
  /** Estimación de tokens de la respuesta recibida; opcional. */
  readonly responseTokenEstimate?: number;
  /** Latencia de la invocación en milisegundos; opcional. */
  readonly latencyMs?: number;
  /** Identificadores de los artefactos de contexto usados. */
  readonly artifactIds?: readonly string[];
  /** Identificadores de las memorias usadas. */
  readonly memoryIds?: readonly string[];
  /** Identificadores de los nodos de conocimiento usados. */
  readonly knowledgeNodeIds?: readonly string[];
  /** Identificadores de las reglas de tenant aplicadas. */
  readonly tenantRuleIds?: readonly string[];
  /** Conflictos detectados durante el ensamblado del contexto. */
  readonly conflicts?: readonly string[];
  /** Mensaje de error si la invocación falló; opcional. */
  readonly errorMessage?: string;
}

/**
 * Datos de entrada para iniciar una ejecución de construcción de contexto.
 */
export interface CreateContextBuildRunInput {
  readonly tenantId: string;
  /** Tipo de ejecución de construcción (e.g., completa o incremental). */
  readonly runType: string;
  readonly createdByUserId?: string;
  readonly metadata?: unknown;
}

/**
 * Datos de entrada para finalizar una ejecución de construcción de contexto.
 */
export interface CompleteContextBuildRunInput {
  readonly runId: string;
  /** Estado final de la ejecución; restringido a éxito o fallo. */
  readonly status: Extract<ContextBuildRunStatus, 'SUCCESS' | 'FAILED'>;
  /** Mensaje de error cuando la ejecución falló; opcional. */
  readonly errorMessage?: string;
  readonly metadata?: unknown;
}

/**
 * Datos de entrada para insertar o actualizar (upsert) un nodo del grafo de conocimiento.
 *
 * La deduplicación se basa en `dedupeKey` dentro del alcance indicado.
 */
export interface UpsertKnowledgeNodeInput {
  readonly tenantId: string;
  /** Alcance del nodo (global o por tenant). */
  readonly scope: AgentMemoryScope;
  /** Tipo de nodo (e.g., recurso, servicio, recomendación). */
  readonly nodeType: string;
  /** Clave de deduplicación del nodo dentro del alcance. */
  readonly dedupeKey: string;
  /** Identificador externo del nodo en su sistema de origen; opcional. */
  readonly externalId?: string;
  /** Etiqueta legible del nodo. */
  readonly label: string;
  readonly metadata?: unknown;
}

/**
 * Datos de entrada para insertar o actualizar (upsert) una arista del grafo de conocimiento.
 *
 * Representa una relación dirigida entre dos nodos; se deduplica por `dedupeKey`.
 */
export interface UpsertKnowledgeEdgeInput {
  readonly tenantId: string;
  /** Alcance de la arista (global o por tenant). */
  readonly scope: AgentMemoryScope;
  /** Nodo de origen de la relación. */
  readonly sourceNodeId: string;
  /** Nodo de destino de la relación. */
  readonly targetNodeId: string;
  /** Tipo de relación entre los nodos. */
  readonly relationType: string;
  /** Clave de deduplicación de la arista dentro del alcance. */
  readonly dedupeKey: string;
  /** Nivel de confianza de la relación. */
  readonly confidence: number;
  readonly metadata?: unknown;
}

/**
 * Agregado de costo por recurso y periodo en formato FOCUS.
 *
 * Proyección desnormalizada usada para construir el contexto de la IA con cifras
 * de costo y consumo ya consolidadas por recurso.
 */
export interface FocusResourcePeriodAggregate {
  readonly tenantId: string;
  readonly provider: string;
  readonly cloudAccountId: string;
  readonly serviceName: string;
  readonly resourceId: string;
  /** Inicio del periodo agregado. */
  readonly periodStart: Date;
  /** Fin del periodo agregado. */
  readonly periodEnd: Date;
  /** Costo facturado en el periodo. */
  readonly billedCost: number;
  /** Cantidad consumida en el periodo; opcional. */
  readonly consumedQuantity?: number;
  /** Unidad de la cantidad consumida; opcional. */
  readonly consumedUnit?: string;
  /** Código de moneda de los importes. */
  readonly currency: string;
  /** Número de métricas que componen el agregado. */
  readonly metricCount: number;
}

/**
 * Contrato de repositorio del contexto del agente.
 *
 * Puerto de dominio (DIP) cuya implementación concreta reside en la capa de
 * infraestructura. Centraliza la persistencia de perfiles de instrucciones,
 * reglas de tenant, resúmenes de contexto, trazas de IA, ejecuciones de
 * construcción y el grafo de conocimiento que nutre al motor de contexto.
 */
export interface IAgentContextRepository {
  /**
   * Obtiene el perfil de instrucciones del agente actualmente activo.
   *
   * @returns El perfil activo; `null` si no hay ninguno activado.
   */
  findActiveProfile(): Promise<AgentInstructionProfile | null>;

  /**
   * Activa un nuevo perfil de instrucciones del agente.
   *
   * @param input - Reglas, notas e informe de validación del perfil.
   * @returns El perfil de instrucciones activado.
   */
  activateProfile(input: ActivateAgentProfileInput): Promise<AgentInstructionProfile>;

  /**
   * Lista las reglas de agente definidas por un tenant.
   *
   * @param tenantId - Tenant cuyas reglas se listan.
   * @returns Reglas del tenant (posiblemente vacío).
   */
  listTenantRules(tenantId: string): Promise<TenantAgentRule[]>;

  /**
   * Crea una regla de agente para un tenant.
   *
   * @param input - Datos de la regla a crear.
   * @returns La regla creada.
   */
  createTenantRule(input: CreateTenantAgentRuleInput): Promise<TenantAgentRule>;

  /**
   * Deshabilita una regla de agente de un tenant.
   *
   * @param tenantId - Tenant propietario de la regla.
   * @param ruleId   - Identificador de la regla a deshabilitar.
   * @returns La regla deshabilitada; `null` si no existe o no pertenece al tenant.
   */
  disableTenantRule(tenantId: string, ruleId: string): Promise<TenantAgentRule | null>;

  /**
   * Registra un evento de auditoría relacionado con instrucciones del agente.
   *
   * @param input - Datos del evento de auditoría (actor, acción, entidad y metadatos).
   */
  createInstructionAuditEvent(input: {
    readonly tenantId?: string;
    readonly actorUserId?: string;
    readonly action: string;
    readonly entityType: string;
    readonly entityId?: string;
    readonly metadata?: unknown;
  }): Promise<void>;

  /**
   * Busca resúmenes de contexto relevantes a una consulta de texto.
   *
   * @param input - Tenant, texto de consulta y límite de resultados.
   * @returns Artefactos de contexto relevantes (posiblemente vacío).
   */
  findContextSummaries(input: {
    readonly tenantId: string;
    readonly queryText: string;
    readonly limit: number;
  }): Promise<ContextArtifact[]>;

  /**
   * Inserta o actualiza un resumen de contexto.
   *
   * @param input - Datos del resumen a persistir.
   * @returns El artefacto de contexto resultante.
   */
  upsertContextSummary(input: UpsertContextSummaryInput): Promise<ContextArtifact>;

  /**
   * Registra una traza de uso de contexto de IA.
   *
   * @param input - Datos de la invocación y fuentes de contexto usadas.
   * @returns La traza creada.
   */
  createAiContextTrace(input: CreateAiContextTraceInput): Promise<AiContextTrace>;

  /**
   * Lista las trazas de contexto de IA de un tenant.
   *
   * @param input - Tenant y límite de resultados.
   * @returns Trazas de contexto (posiblemente vacío).
   */
  listAiContextTraces(input: {
    readonly tenantId: string;
    readonly limit: number;
  }): Promise<AiContextTrace[]>;

  /**
   * Inicia una ejecución de construcción de contexto.
   *
   * @param input - Datos de la ejecución a iniciar.
   * @returns Identificador de la ejecución creada.
   */
  createContextBuildRun(input: CreateContextBuildRunInput): Promise<string>;

  /**
   * Finaliza una ejecución de construcción de contexto.
   *
   * @param input - Estado final y metadatos de la ejecución.
   */
  completeContextBuildRun(input: CompleteContextBuildRunInput): Promise<void>;

  /**
   * Lista los agregados de costo por recurso y periodo (formato FOCUS) de un tenant.
   *
   * @param tenantId - Tenant cuyos agregados se listan.
   * @returns Agregados de costo por recurso y periodo.
   */
  listFocusResourcePeriodAggregates(tenantId: string): Promise<FocusResourcePeriodAggregate[]>;

  /**
   * Inserta o actualiza un nodo del grafo de conocimiento.
   *
   * @param input - Datos del nodo a persistir.
   * @returns Identificador del nodo resultante.
   */
  upsertKnowledgeNode(input: UpsertKnowledgeNodeInput): Promise<string>;

  /**
   * Inserta o actualiza una arista del grafo de conocimiento.
   *
   * @param input - Datos de la arista a persistir.
   * @returns Identificador de la arista resultante.
   */
  upsertKnowledgeEdge(input: UpsertKnowledgeEdgeInput): Promise<string>;

  /**
   * Recupera un subgrafo de conocimiento alrededor de una recomendación o recurso.
   *
   * @param input - Tenant, semilla (recomendación o recurso) y profundidad de exploración.
   * @returns El contexto del grafo de conocimiento recuperado.
   */
  getKnowledgeGraph(input: {
    readonly tenantId: string;
    readonly recommendationId?: string;
    readonly resourceId?: string;
    readonly depth: number;
  }): Promise<KnowledgeGraphContext>;
}
