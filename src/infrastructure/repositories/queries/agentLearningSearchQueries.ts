import type { CreateAgentLearningEventInput } from '../../../domain/interfaces/IAgentLearningRepository.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import type {
  CaseContextRow,
  MemoryContextRow,
  PatternCountRow,
} from '../mappers/agentLearningMappers.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Consultas de búsqueda de texto completo del aprendizaje del agente
 * ═══════════════════════════════════════════════════════════════
 *
 * Aísla las consultas `$queryRaw` con full-text search en español
 * (`to_tsvector('spanish', ...)` + `plainto_tsquery`) del repositorio de
 * aprendizaje: el contexto de aprendizaje por recomendación (memorias visibles
 * + casos previos) y el conteo de patrones de decisión aprobados transversal a
 * tenants. Devuelven filas crudas tipadas para que el repositorio las mapee.
 *
 * Importante: el idioma `'spanish'` del full-text es semántico (afecta al
 * stemming) y NO debe alterarse. Este módulo NO importa del repositorio (evita
 * ciclos).
 *
 * @module infrastructure/repositories/queries/agentLearningSearchQueries
 */

/** Filas crudas del contexto de aprendizaje por recomendación: memorias y casos. */
export interface RecommendationLearningRows {
  readonly memories: MemoryContextRow[];
  readonly cases: CaseContextRow[];
}

/**
 * Ejecuta en paralelo las dos consultas de texto completo que componen el
 * contexto de aprendizaje de una recomendación:
 * - Memorias activas visibles para el tenant: incluye las de ámbito `GLOBAL`
 *   (compartidas entre tenants) y las `LOCAL` del propio `tenantId` (aislamiento
 *   multi-tenant). Prioriza las `GLOBAL`, luego por confianza y recencia.
 * - Casos previos: decisiones sobre recomendaciones del tenant que tengan
 *   `reason_code`, uniendo `recommendation_decisions` con `recommendations` y
 *   buscando en título, descripción y motivo.
 * Cuando `queryText` está vacío, ambas consultas omiten el filtro de texto.
 *
 * @param prisma Cliente Prisma.
 * @param tenantId Tenant cuyo contexto se consulta.
 * @param queryText Texto de búsqueda ya recortado (`''` para omitir el filtro).
 * @param limit Límite de registros por cada fuente.
 * @returns Filas crudas de memorias y casos.
 */
export async function queryRecommendationLearningContext(
  prisma: PrismaClient,
  tenantId: string,
  queryText: string,
  limit: number,
): Promise<RecommendationLearningRows> {
  const [memories, cases] = await Promise.all([
    // Memorias activas relevantes: GLOBAL (compartidas) + LOCAL del tenant.
    // Full-text search en español sobre el contenido; si queryText está vacío,
    // se omite el filtro de texto. Prioriza GLOBAL, luego confianza y recencia.
    prisma.$queryRaw<MemoryContextRow[]>`
      select id,
             scope::text as scope,
             memory_type::text as memory_type,
             content,
             confidence::float8 as confidence,
             created_at
      from agent_memory
      where active = true
        and (scope = 'GLOBAL'::"AgentMemoryScope" or tenant_id = ${tenantId})
        and (
          ${queryText} = ''
          or to_tsvector('spanish', coalesce(content, '')) @@ plainto_tsquery('spanish', ${queryText})
        )
      order by
        case when scope = 'GLOBAL'::"AgentMemoryScope" then 0 else 1 end,
        confidence desc,
        created_at desc
      limit ${limit}
    `,
    // Casos previos: decisiones humanas con reason_code sobre recomendaciones
    // del tenant (join recommendation_decisions + recommendations, filtrado por
    // r.tenant_id para aislamiento multi-tenant). Full-text en español sobre
    // título + descripción + motivo. Más recientes primero.
    prisma.$queryRaw<CaseContextRow[]>`
      select d.id as decision_id,
             d.decision::text as decision,
             d.reason_code::text as reason_code,
             d.reason,
             r.type as recommendation_type,
             r.title,
             r.description,
             d.created_at
      from recommendation_decisions d
      inner join recommendations r on r.id = d.recommendation_id
      where r.tenant_id = ${tenantId}
        and d.reason_code is not null
        and (
          ${queryText} = ''
          or to_tsvector(
            'spanish',
            coalesce(r.title, '') || ' ' || coalesce(r.description, '') || ' ' || coalesce(d.reason, '')
          ) @@ plainto_tsquery('spanish', ${queryText})
        )
      order by d.created_at desc
      limit ${limit}
    `,
  ]);

  return { memories, cases };
}

/**
 * Cuenta, mediante SQL crudo, los eventos de aprendizaje aprobados que comparten
 * un mismo patrón de decisión, de forma transversal a todos los tenants.
 *
 * Calcula cuántos eventos (`event_count`) y cuántos tenants distintos
 * (`tenant_count`) coinciden con el patrón formado por `reason_code`,
 * `recommendation_type` y `decision`, restringido a estado `APPROVED`. No filtra
 * por tenant de forma intencionada (mide consenso entre tenants).
 *
 * @param prisma Cliente Prisma.
 * @param input Patrón a contar (reason code, tipo de recomendación y decisión).
 * @returns Filas crudas con los conteos (normalmente una sola fila).
 */
export async function countSimilarApprovedEventRows(
  prisma: PrismaClient,
  input: {
    readonly reasonCode: CreateAgentLearningEventInput['reasonCode'];
    readonly recommendationType: string;
    readonly decision: 'APPROVED' | 'REJECTED';
  },
): Promise<PatternCountRow[]> {
  return prisma.$queryRaw<PatternCountRow[]>`
    select count(*)::int as event_count,
           count(distinct tenant_id)::int as tenant_count
    from agent_learning_events
    where status = 'APPROVED'::"AgentLearningStatus"
      and reason_code = ${input.reasonCode}::"RecommendationFeedbackReason"
      and recommendation_type = ${input.recommendationType}
      and decision = ${input.decision}::"RecommendationDecisionType"
  `;
}
