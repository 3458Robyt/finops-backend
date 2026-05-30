import type {
  ActivateAgentProfileInput,
  CompleteContextBuildRunInput,
  CreateAiContextTraceInput,
  CreateContextBuildRunInput,
  CreateTenantAgentRuleInput,
  FocusResourcePeriodAggregate,
  IAgentContextRepository,
  UpsertContextSummaryInput,
  UpsertKnowledgeEdgeInput,
  UpsertKnowledgeNodeInput,
} from '../../domain/interfaces/IAgentContextRepository.js';
import type {
  AgentInstructionProfile,
  AiContextTrace,
  ContextArtifact,
  KnowledgeGraphContext,
  TenantAgentRule,
} from '../../domain/models/AgentContext.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import {
  toFocusResourcePeriodAggregate,
  toProfile,
  toTenantRule,
} from './mappers/agentContextMappers.js';
import { queryFocusResourcePeriodAggregates } from './queries/agentContextFocusQueries.js';
import { getKnowledgeGraph } from './queries/agentKnowledgeGraphQueries.js';
import {
  findContextSummaries,
  upsertContextSummary,
} from './queries/contextSummaryQueries.js';
import {
  completeContextBuildRun,
  createAiContextTrace,
  createContextBuildRun,
  listAiContextTraces,
} from './queries/agentContextObservabilityQueries.js';
import {
  upsertKnowledgeEdge,
  upsertKnowledgeNode,
} from './queries/agentContextGraphWrites.js';

/**
 * Adaptador de infraestructura (Clean Architecture) que implementa el puerto de
 * dominio {@link IAgentContextRepository} sobre Prisma/PostgreSQL.
 *
 * Responsabilidad: gestionar el contexto del agente IA. Mantiene aquí el núcleo
 * de perfiles de instrucciones versionados (`agent_instruction_profiles`), las
 * reglas por tenant (`tenant_agent_rules`) y la auditoría de instrucciones; y
 * delega en colaboradores de consulta la caché de resúmenes
 * ({@link ./queries/contextSummaryQueries}), la observabilidad —trazas y build
 * runs— ({@link ./queries/agentContextObservabilityQueries}), las agregaciones
 * FOCUS ({@link ./queries/agentContextFocusQueries}) y el grafo de conocimiento
 * ({@link ./queries/agentContextGraphWrites} y
 * {@link ./queries/agentKnowledgeGraphQueries}). Las operaciones por tenant
 * aplican aislamiento multi-tenant.
 */
export class PrismaAgentContextRepository implements IAgentContextRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Obtiene el perfil de instrucciones del agente actualmente activo (el de
   * mayor versión con estado `ACTIVE`).
   *
   * @returns El perfil activo de dominio, o `null` si no hay ninguno activo.
   */
  public async findActiveProfile(): Promise<AgentInstructionProfile | null> {
    const row = await this.prisma.agentInstructionProfile.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { version: 'desc' },
    });

    return row === null ? null : toProfile(row);
  }

  /**
   * Activa un nuevo perfil de instrucciones, archivando el anterior, de forma
   * atómica.
   *
   * Dentro de una transacción: (1) determina la siguiente versión (máxima + 1);
   * (2) archiva el perfil actualmente activo (estado `ARCHIVED`); y (3) crea el
   * nuevo perfil como `ACTIVE`. Invariante: a lo sumo existe un perfil `ACTIVE` a
   * la vez. Los campos JSON (`structuredRules`, `validationReport`) se serializan
   * como JSON de Prisma; `freeformNotes` es opcional.
   *
   * @param input Datos de activación (reglas estructuradas, notas opcionales,
   *   reporte de validación y usuario que actúa).
   * @returns El perfil recién activado en formato de dominio.
   */
  public async activateProfile(input: ActivateAgentProfileInput): Promise<AgentInstructionProfile> {
    const row = await this.prisma.$transaction(async (tx) => {
      const latest = await tx.agentInstructionProfile.findFirst({
        orderBy: { version: 'desc' },
      });
      const version = (latest?.version ?? 0) + 1;

      await tx.agentInstructionProfile.updateMany({
        where: { status: 'ACTIVE' },
        data: { status: 'ARCHIVED' },
      });

      return tx.agentInstructionProfile.create({
        data: {
          version,
          status: 'ACTIVE',
          structuredRules: input.structuredRules as unknown as Prisma.InputJsonValue,
          ...(input.freeformNotes !== undefined ? { freeformNotes: input.freeformNotes } : {}),
          validationReport: input.validationReport as unknown as Prisma.InputJsonValue,
          activatedAt: new Date(),
          createdByUserId: input.actorUserId,
          activatedByUserId: input.actorUserId,
        },
      });
    });

    return toProfile(row);
  }

  /**
   * Lista las reglas activas del agente para un tenant.
   *
   * Filtra por `tenantId` y estado `ACTIVE` (aislamiento multi-tenant), ordenando
   * por prioridad ascendente y, a igualdad, por fecha de creación descendente.
   *
   * @param tenantId Tenant cuyas reglas se listan.
   * @returns Lista de reglas de dominio; arreglo vacío si no hay reglas activas.
   */
  public async listTenantRules(tenantId: string): Promise<TenantAgentRule[]> {
    const rows = await this.prisma.tenantAgentRule.findMany({
      where: { tenantId, status: 'ACTIVE' },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });

    return rows.map(toTenantRule);
  }

  /**
   * Crea una nueva regla del agente para un tenant.
   *
   * @param input Datos de la regla (tenant, categoría, texto, prioridad y autor).
   * @returns La regla creada en formato de dominio.
   */
  public async createTenantRule(input: CreateTenantAgentRuleInput): Promise<TenantAgentRule> {
    const row = await this.prisma.tenantAgentRule.create({
      data: {
        tenantId: input.tenantId,
        category: input.category,
        ruleText: input.ruleText,
        priority: input.priority,
        createdByUserId: input.createdByUserId,
      },
    });

    return toTenantRule(row);
  }

  /**
   * Deshabilita una regla del agente, validando previamente su pertenencia al
   * tenant.
   *
   * Comprueba que la regla exista dentro del tenant (aislamiento multi-tenant)
   * antes de marcarla como `DISABLED` y registrar `disabledAt`.
   *
   * @param tenantId Tenant propietario de la regla.
   * @param ruleId Identificador de la regla a deshabilitar.
   * @returns La regla deshabilitada de dominio, o `null` si no existe o no
   *   pertenece al tenant.
   */
  public async disableTenantRule(tenantId: string, ruleId: string): Promise<TenantAgentRule | null> {
    const existing = await this.prisma.tenantAgentRule.findFirst({
      where: { id: ruleId, tenantId },
    });

    if (existing === null) {
      return null;
    }

    const row = await this.prisma.tenantAgentRule.update({
      where: { id: ruleId },
      data: {
        status: 'DISABLED',
        disabledAt: new Date(),
      },
    });

    return toTenantRule(row);
  }

  /**
   * Registra un evento de auditoría sobre las instrucciones del agente
   * (`agent_instruction_audit_events`).
   *
   * Deja traza de quién hizo qué sobre qué entidad. Todos los campos salvo
   * `action` y `entityType` son opcionales y solo se incluyen cuando están
   * definidos; `metadata` se serializa como JSON de Prisma.
   *
   * @param input Datos del evento de auditoría.
   * @returns Promesa que se resuelve cuando el evento queda persistido.
   */
  public async createInstructionAuditEvent(input: {
    readonly tenantId?: string;
    readonly actorUserId?: string;
    readonly action: string;
    readonly entityType: string;
    readonly entityId?: string;
    readonly metadata?: unknown;
  }): Promise<void> {
    await this.prisma.agentInstructionAuditEvent.create({
      data: {
        ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
        ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
        action: input.action,
        entityType: input.entityType,
        ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });
  }

  /**
   * Busca resúmenes de contexto cacheados de un tenant que coincidan con el texto
   * de consulta. Delega en {@link findContextSummaries} (búsqueda por palabras
   * clave, aislamiento multi-tenant).
   */
  public async findContextSummaries(input: {
    readonly tenantId: string;
    readonly queryText: string;
    readonly limit: number;
  }): Promise<ContextArtifact[]> {
    return findContextSummaries(this.prisma, input);
  }

  /**
   * Inserta o actualiza (upsert) un resumen de contexto en la caché. Delega en
   * {@link upsertContextSummary} (unicidad por tenant/tipo/scope/sourceHash).
   */
  public async upsertContextSummary(input: UpsertContextSummaryInput): Promise<ContextArtifact> {
    return upsertContextSummary(this.prisma, input);
  }

  /**
   * Crea una traza de contexto IA para observabilidad. Delega en
   * {@link createAiContextTrace}.
   */
  public async createAiContextTrace(input: CreateAiContextTraceInput): Promise<AiContextTrace> {
    return createAiContextTrace(this.prisma, input);
  }

  /**
   * Lista las trazas de contexto IA de un tenant, de la más reciente a la más
   * antigua. Delega en {@link listAiContextTraces}.
   */
  public async listAiContextTraces(input: {
    readonly tenantId: string;
    readonly limit: number;
  }): Promise<AiContextTrace[]> {
    return listAiContextTraces(this.prisma, input);
  }

  /**
   * Inicia una ejecución de construcción de contexto en estado `RUNNING`. Delega
   * en {@link createContextBuildRun}.
   */
  public async createContextBuildRun(input: CreateContextBuildRunInput): Promise<string> {
    return createContextBuildRun(this.prisma, input);
  }

  /**
   * Finaliza una ejecución de construcción de contexto. Delega en
   * {@link completeContextBuildRun}.
   */
  public async completeContextBuildRun(input: CompleteContextBuildRunInput): Promise<void> {
    return completeContextBuildRun(this.prisma, input);
  }

  /**
   * Calcula las agregaciones FOCUS de coste por recurso y mes natural para un
   * tenant (aislamiento multi-tenant) y las mapea a dominio.
   *
   * Delega la consulta `$queryRaw` en
   * {@link queryFocusResourcePeriodAggregates}; allí se documenta el detalle del
   * SQL (agrupación, tratamiento de unidades mixtas y divisa representativa).
   *
   * @param tenantId Tenant cuyas agregaciones se calculan.
   * @returns Agregaciones por recurso/periodo de dominio; los campos de consumo
   *   anulables solo se incluyen cuando no son `null`.
   */
  public async listFocusResourcePeriodAggregates(tenantId: string): Promise<FocusResourcePeriodAggregate[]> {
    const rows = await queryFocusResourcePeriodAggregates(this.prisma, tenantId);

    return rows.map(toFocusResourcePeriodAggregate);
  }

  /**
   * Inserta o actualiza (upsert) un nodo del grafo de conocimiento del agente.
   * Delega en {@link upsertKnowledgeNode} (unicidad por tenant + dedupeKey).
   *
   * @returns El identificador del nodo creado o actualizado.
   */
  public async upsertKnowledgeNode(input: UpsertKnowledgeNodeInput): Promise<string> {
    return upsertKnowledgeNode(this.prisma, input);
  }

  /**
   * Inserta o actualiza (upsert) una arista del grafo de conocimiento. Delega en
   * {@link upsertKnowledgeEdge} (unicidad por tenant + dedupeKey).
   *
   * @returns El identificador de la arista creada o actualizada.
   */
  public async upsertKnowledgeEdge(input: UpsertKnowledgeEdgeInput): Promise<string> {
    return upsertKnowledgeEdge(this.prisma, input);
  }

  /**
   * Recupera un subgrafo del grafo de conocimiento del agente para un tenant
   * (aislamiento multi-tenant).
   *
   * Delega en {@link getKnowledgeGraph}; allí se documenta el detalle de los dos
   * modos (vista general acotada y recorrido BFS por niveles con profundidad
   * acotada a 1..2).
   *
   * @param input Tenant, filtros opcionales por recomendación/recurso y
   *   profundidad de expansión.
   * @returns El subgrafo (nodos y aristas) en formato de dominio; vacío si no hay
   *   nodos semilla en el modo dirigido.
   */
  public async getKnowledgeGraph(input: {
    readonly tenantId: string;
    readonly recommendationId?: string;
    readonly resourceId?: string;
    readonly depth: number;
  }): Promise<KnowledgeGraphContext> {
    return getKnowledgeGraph(this.prisma, input);
  }
}
