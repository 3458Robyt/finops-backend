/**
 * ═══════════════════════════════════════════════════════════════
 * Consultas y cálculo de KPIs de recomendaciones
 * ═══════════════════════════════════════════════════════════════
 *
 * Aísla del repositorio las consultas Prisma (`aggregate`/`groupBy`/`findMany`)
 * y el cálculo de los KPIs de ahorro (estimado, observado, confirmado y ahorro
 * perdido) y de adopción (totales por estado y tasas de aceptación, rechazo y
 * ejecución) de un tenant. Todas las consultas filtran por `tenantId`
 * (aislamiento multi-tenant). Reutiliza los helpers puros de cálculo monetario
 * de los mappers para mantener el repositorio enfocado en la delegación.
 *
 * Importante: este módulo NO debe importar del repositorio (evita ciclos).
 *
 * @module infrastructure/repositories/queries/recommendationKpiQueries
 */
import type {
  AdoptionKpis,
  SavingsKpis,
} from '../../../domain/interfaces/IRecommendationRepository.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import {
  calculateMissedSavings,
  roundCurrency,
} from '../mappers/recommendationMappers.js';

/**
 * Calcula los KPIs de ahorro de un tenant (ahorro estimado, observado,
 * confirmado y ahorro perdido por inacción).
 *
 * Ejecuta en paralelo: (1) suma del ahorro mensual estimado de todas las
 * recomendaciones; (2) suma del ahorro mensual observado en ejecuciones
 * `EXECUTED`/`PARTIAL`; (3) recuento de recomendaciones distintas efectivamente
 * ejecutadas (groupBy); y (4) recomendaciones pendientes/aprobadas con ahorro
 * estimado positivo. Sobre estas últimas calcula el "ahorro perdido"
 * (proporcional al tiempo transcurrido sin ejecutar, ver
 * {@link calculateMissedSavings}), filtrando importes despreciables (< 0.01),
 * acumulando el total redondeado y destacando la recomendación con mayor ahorro
 * perdido. La divisa de los KPIs se fija a `USD`.
 *
 * @param prisma Cliente Prisma.
 * @param tenantId Tenant del que se calculan los KPIs (aislamiento
 *   multi-tenant).
 * @returns KPIs de ahorro de dominio.
 */
export async function computeSavingsKpis(prisma: PrismaClient, tenantId: string): Promise<SavingsKpis> {
  const [estimated, observed, executed, pendingSavings] = await Promise.all([
    prisma.recommendation.aggregate({
      where: { tenantId },
      _sum: { estimatedMonthlySavings: true },
    }),
    prisma.recommendationManualExecution.aggregate({
      where: {
        tenantId,
        status: { in: ['EXECUTED', 'PARTIAL'] },
      },
      _sum: { observedMonthlySavings: true },
    }),
    prisma.recommendationManualExecution.groupBy({
      by: ['recommendationId'],
      where: {
        tenantId,
        status: { in: ['EXECUTED', 'PARTIAL'] },
      },
    }),
    prisma.recommendation.findMany({
      where: {
        tenantId,
        status: { in: ['PENDING', 'APPROVED'] },
        estimatedMonthlySavings: { gt: 0 },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const observedMonthlySavings = Number(observed._sum.observedMonthlySavings ?? 0);
  const missedSavings = pendingSavings
    .map((recommendation) => ({
      recommendation,
      missedSavingsAmount: calculateMissedSavings(
        Number(recommendation.estimatedMonthlySavings ?? 0),
        recommendation.createdAt,
      ),
    }))
    .filter((item) => item.missedSavingsAmount > 0.01);
  const missedSavingsAmount = roundCurrency(
    missedSavings.reduce((total, item) => total + item.missedSavingsAmount, 0),
  );
  const topMissed = missedSavings
    .sort((left, right) => right.missedSavingsAmount - left.missedSavingsAmount)[0];

  return {
    estimatedMonthlySavings: Number(estimated._sum.estimatedMonthlySavings ?? 0),
    observedMonthlySavings,
    confirmedMonthlySavings: observedMonthlySavings,
    missedSavingsAmount,
    currency: 'USD',
    executedRecommendations: executed.length,
    pendingSavingsRecommendations: pendingSavings.length,
    ...(topMissed !== undefined
      ? {
          topMissedSavingsRecommendation: {
            id: topMissed.recommendation.id,
            title: topMissed.recommendation.title,
            missedSavingsAmount: topMissed.missedSavingsAmount,
            estimatedMonthlySavings: Number(topMissed.recommendation.estimatedMonthlySavings ?? 0),
            currency: topMissed.recommendation.currency,
            createdAt: topMissed.recommendation.createdAt,
            status: topMissed.recommendation.status,
          },
        }
      : {}),
  };
}

/**
 * Calcula los KPIs de adopción de un tenant (totales por estado y tasas de
 * aceptación, rechazo y ejecución).
 *
 * Agrupa las recomendaciones por estado (`groupBy`) y deriva los conteos. Las
 * tasas se calculan de forma defensiva sobre el conjunto de recomendaciones ya
 * "decididas" (aprobadas + rechazadas + completadas), devolviendo 0 cuando el
 * denominador es 0 para evitar divisiones por cero:
 * - `acceptanceRate`: (aprobadas + completadas) / decididas.
 * - `rejectionRate`: rechazadas / decididas.
 * - `executionRate`: completadas / total de recomendaciones.
 *
 * @param prisma Cliente Prisma.
 * @param tenantId Tenant del que se calculan los KPIs (aislamiento
 *   multi-tenant).
 * @returns KPIs de adopción de dominio.
 */
export async function computeAdoptionKpis(prisma: PrismaClient, tenantId: string): Promise<AdoptionKpis> {
  const grouped = await prisma.recommendation.groupBy({
    by: ['status'],
    where: { tenantId },
    _count: true,
  });
  const counts = new Map(grouped.map((row) => [row.status, row._count]));
  const totalRecommendations = grouped.reduce((total, row) => total + row._count, 0);
  const approvedRecommendations = counts.get('APPROVED') ?? 0;
  const rejectedRecommendations = counts.get('REJECTED') ?? 0;
  const completedRecommendations = counts.get('MANUAL_COMPLETED') ?? 0;
  const decided = approvedRecommendations + rejectedRecommendations + completedRecommendations;

  return {
    totalRecommendations,
    pendingRecommendations: counts.get('PENDING') ?? 0,
    approvedRecommendations,
    rejectedRecommendations,
    completedRecommendations,
    acceptanceRate: decided > 0 ? (approvedRecommendations + completedRecommendations) / decided : 0,
    rejectionRate: decided > 0 ? rejectedRecommendations / decided : 0,
    executionRate: totalRecommendations > 0 ? completedRecommendations / totalRecommendations : 0,
  };
}
