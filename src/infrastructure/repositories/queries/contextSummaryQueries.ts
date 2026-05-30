import type {
  UpsertContextSummaryInput,
} from '../../../domain/interfaces/IAgentContextRepository.js';
import type { ContextArtifact } from '../../../domain/models/AgentContext.js';
import { Prisma, type PrismaClient } from '../../../generated/prisma/client.js';
import { toContextArtifact } from '../mappers/agentContextMappers.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Consultas de la caché de resúmenes de contexto del agente
 * ═══════════════════════════════════════════════════════════════
 *
 * Aísla el acceso a `context_summary_cache` del repositorio de contexto: la
 * búsqueda por palabras clave de resúmenes cacheados y el upsert por clave de
 * unicidad. Devuelven artefactos de dominio (vía {@link toContextArtifact}).
 * Todas las operaciones filtran por `tenantId` (aislamiento multi-tenant).
 *
 * Importante: este módulo NO importa del repositorio (evita ciclos).
 *
 * @module infrastructure/repositories/queries/contextSummaryQueries
 */

/**
 * Busca resúmenes de contexto cacheados de un tenant que coincidan con el texto
 * de consulta (búsqueda por palabras clave).
 *
 * Tokeniza `queryText` por espacios, descarta tokens de menos de 3 caracteres y
 * toma hasta 8 tokens. Construye una búsqueda `OR` insensible a mayúsculas
 * sobre `summary`, `scopeKey`, `serviceName` y `resourceId`. Siempre filtra por
 * `tenantId` (aislamiento multi-tenant). Si no hay tokens útiles, devuelve los
 * más recientes del tenant. Ordena por `updatedAt` descendente y limita a
 * `limit`.
 *
 * @param prisma Cliente Prisma.
 * @param input Tenant, texto de consulta y límite de resultados.
 * @returns Lista de artefactos de contexto de dominio; arreglo vacío si no hay
 *   coincidencias.
 */
export async function findContextSummaries(
  prisma: PrismaClient,
  input: {
    readonly tenantId: string;
    readonly queryText: string;
    readonly limit: number;
  },
): Promise<ContextArtifact[]> {
  const tokens = input.queryText
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 8);

  const rows = await prisma.contextSummaryCache.findMany({
    where: {
      tenantId: input.tenantId,
      ...(tokens.length > 0
        ? {
            OR: tokens.flatMap((token) => [
              { summary: { contains: token, mode: 'insensitive' as const } },
              { scopeKey: { contains: token, mode: 'insensitive' as const } },
              { serviceName: { contains: token, mode: 'insensitive' as const } },
              { resourceId: { contains: token, mode: 'insensitive' as const } },
            ]),
          }
        : {}),
    },
    orderBy: [{ updatedAt: 'desc' }],
    take: input.limit,
  });

  return rows.map(toContextArtifact);
}

/**
 * Inserta o actualiza (upsert) un resumen de contexto en la caché.
 *
 * La clave de unicidad combina `tenantId`, `artifactType`, `scopeKey` y
 * `sourceHash`: si cambia el contenido de origen (distinto `sourceHash`) se crea
 * una nueva entrada; si coincide, se actualiza la existente. Los campos
 * opcionales solo se incluyen cuando están definidos; `facts` y `evidenceRefs`
 * se serializan como JSON de Prisma. El filtro por `tenantId` mantiene el
 * aislamiento multi-tenant.
 *
 * @param prisma Cliente Prisma.
 * @param input Datos del resumen a insertar/actualizar.
 * @returns El artefacto de contexto resultante en formato de dominio.
 */
export async function upsertContextSummary(
  prisma: PrismaClient,
  input: UpsertContextSummaryInput,
): Promise<ContextArtifact> {
  const row = await prisma.contextSummaryCache.upsert({
    where: {
      tenantId_artifactType_scopeKey_sourceHash: {
        tenantId: input.tenantId,
        artifactType: input.artifactType,
        scopeKey: input.scopeKey,
        sourceHash: input.sourceHash,
      },
    },
    update: {
      summary: input.summary,
      tokenEstimate: input.tokenEstimate,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.cloudAccountId !== undefined ? { cloudAccountId: input.cloudAccountId } : {}),
      ...(input.serviceName !== undefined ? { serviceName: input.serviceName } : {}),
      ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
      ...(input.periodStart !== undefined ? { periodStart: input.periodStart } : {}),
      ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
      ...(input.facts !== undefined ? { facts: input.facts as Prisma.InputJsonValue } : {}),
      ...(input.evidenceRefs !== undefined ? { evidenceRefs: input.evidenceRefs as Prisma.InputJsonValue } : {}),
    },
    create: {
      tenantId: input.tenantId,
      artifactType: input.artifactType,
      scopeKey: input.scopeKey,
      sourceHash: input.sourceHash,
      summary: input.summary,
      tokenEstimate: input.tokenEstimate,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.cloudAccountId !== undefined ? { cloudAccountId: input.cloudAccountId } : {}),
      ...(input.serviceName !== undefined ? { serviceName: input.serviceName } : {}),
      ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
      ...(input.periodStart !== undefined ? { periodStart: input.periodStart } : {}),
      ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
      ...(input.facts !== undefined ? { facts: input.facts as Prisma.InputJsonValue } : {}),
      ...(input.evidenceRefs !== undefined ? { evidenceRefs: input.evidenceRefs as Prisma.InputJsonValue } : {}),
    },
  });

  return toContextArtifact(row);
}
