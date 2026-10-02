import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type { RecommendationCostEvidenceScope } from '../../domain/interfaces/IRecommendationRepository.js';
import { CloudProvider, type PrismaClient } from '../../generated/prisma/client.js';

export function hasRecommendationCandidateEvidence(value: unknown): boolean {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'candidateId' in value
    && typeof value.candidateId === 'string'
    && value.candidateId.trim() !== '';
}

export async function resolveRecommendationCostEvidence(
  prisma: PrismaClient,
  tenantId: string,
  scope: RecommendationCostEvidenceScope,
) {
  const periodStart = new Date(scope.periodStart);
  const periodEnd = new Date(scope.periodEnd);
  if (!Number.isFinite(periodStart.getTime()) || !Number.isFinite(periodEnd.getTime()) || periodStart >= periodEnd) {
    throw new FinOpsBaseError('El período de evidencia de costo no es válido.', 'AI_EVIDENCE_RESOLUTION_FAILED');
  }

  const metrics = await prisma.costMetric.findMany({
    where: {
      tenantId,
      cloudAccountId: scope.cloudAccountId,
      provider: scope.provider as CloudProvider,
      resourceId: scope.resourceId,
      chargePeriodStart: { gte: periodStart, lt: periodEnd },
      ...(scope.cloudConnectionId === undefined ? {} : { cloudConnectionId: scope.cloudConnectionId }),
    },
    select: {
      cloudAccountId: true,
      cloudConnectionId: true,
      cloudResourceId: true,
      provider: true,
      resourceId: true,
      serviceName: true,
      chargePeriodStart: true,
      metricIdentityHash: true,
      billingCurrency: true,
      billedCost: true,
    },
    orderBy: [{ chargePeriodStart: 'asc' }, { metricIdentityHash: 'asc' }],
  });

  if (metrics.length !== scope.expectedMetricCount || metrics.some((metric) =>
    metric.cloudResourceId !== scope.cloudResourceId || metric.serviceName !== scope.serviceName)) {
    throw new FinOpsBaseError(
      'Las líneas de costo no coinciden completamente con el recurso y alcance verificados.',
      'AI_EVIDENCE_RESOLUTION_FAILED',
    );
  }

  return metrics.map((metric) => {
    if (metric.cloudResourceId === null) {
      throw new FinOpsBaseError('La línea de costo perdió su enlace canónico durante la captura de evidencia.', 'AI_EVIDENCE_RESOLUTION_FAILED');
    }
    return {
      tenantId,
      cloudAccountId: metric.cloudAccountId,
      ...(metric.cloudConnectionId === null ? {} : { cloudConnectionId: metric.cloudConnectionId }),
      cloudResourceId: metric.cloudResourceId,
      provider: metric.provider,
      resourceId: metric.resourceId,
      serviceName: metric.serviceName,
      chargePeriodStart: metric.chargePeriodStart,
      metricIdentityHash: metric.metricIdentityHash,
      billingCurrency: metric.billingCurrency,
      billedCost: metric.billedCost,
    };
  });
}
