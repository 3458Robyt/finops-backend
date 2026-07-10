import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type {
  IResourceMetricRepository,
  ResourceMetricSampleItem,
  TechnicalCostContextItem,
} from '../../../domain/interfaces/IResourceMetricRepository.js';
import { evaluateTechnicalOptimizationRules } from './TechnicalOptimizationRuleEngine.js';

export interface TechnicalRecommendationEvidenceProvider {
  buildRecommendationEvidence(input: {
    readonly tenantId: string;
    readonly snapshot: CostAnalyticsSnapshot;
  }): Promise<string>;
}

interface ResourceEvidence {
  readonly cloudResourceId?: string;
  readonly externalResourceId: string;
  readonly provider: string;
  readonly cost?: {
    readonly totalCost: number;
    readonly currency: string;
    readonly metricCount: number;
  };
  readonly technicalEvidenceRefs: readonly string[];
  readonly metrics: readonly MetricEvidence[];
}

interface MetricEvidence {
  readonly metricName: string;
  readonly metricUnit?: string;
  readonly sampleCount: number;
  readonly coverageDays: number;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly latest: number;
  readonly latestSampleAt: string;
  readonly evidenceRef: string;
}

const maxSamples = 5000;
const maxResources = 12;
const maxMetricsPerResource = 8;

export class TechnicalRecommendationEvidenceService implements TechnicalRecommendationEvidenceProvider {
  public constructor(private readonly repository: IResourceMetricRepository) {}

  public async buildRecommendationEvidence(input: {
    readonly tenantId: string;
    readonly snapshot: CostAnalyticsSnapshot;
  }): Promise<string> {
    const startDate = new Date(input.snapshot.periodStart);
    const endDate = new Date(input.snapshot.periodEnd);
    const boundedStartDate = Number.isNaN(startDate.getTime()) ? undefined : startDate;
    const boundedEndDate = Number.isNaN(endDate.getTime()) ? undefined : endDate;

    const samples = await this.repository.listMetricSamplesForTenantByFilter(input.tenantId, {
      ...(boundedStartDate !== undefined ? { startDate: boundedStartDate } : {}),
      ...(boundedEndDate !== undefined ? { endDate: boundedEndDate } : {}),
      limit: maxSamples,
    });

    if (samples.length === 0) {
      return [
        'Evidencia tecnica real disponible:',
        JSON.stringify({
          evidenceLevel: 'NO_TECHNICAL_EVIDENCE',
          guidance:
            'No hay muestras tecnicas en resource_metric_samples para este periodo. No generes recomendaciones tecnicas fuertes; marca requiresTechnicalValidation=true.',
        }),
      ].join('\n');
    }

    const resourceIds = [...new Set(samples.map((sample) => sample.externalResourceId))];
    const costContext = await this.repository.listCostContextForResources(input.tenantId, resourceIds);
    const technicalSummaries = await this.repository.listMetricSummariesForTenant(input.tenantId, {
      ...(boundedStartDate !== undefined ? { startDate: boundedStartDate } : {}),
      ...(boundedEndDate !== undefined ? { endDate: boundedEndDate } : {}),
      externalResourceIds: resourceIds,
      limit: 1000,
    });
    const deterministicRules = evaluateTechnicalOptimizationRules({
      summaries: technicalSummaries,
      referenceDate: boundedEndDate ?? new Date(),
    });
    const resources = buildResourceEvidence(samples, costContext);

    return [
      'Evidencia tecnica real disponible:',
      JSON.stringify({
        evidenceLevel: 'COST_USAGE_AND_TECHNICAL_AVAILABLE',
      rules: [
        'Solo usa COST_USAGE_AND_TECHNICAL para acciones tecnicas si citas technicalEvidenceRefs existentes en este bloque.',
        'Si el recurso no aparece aqui o la cobertura/frescura es debil, marca requiresTechnicalValidation=true.',
        'No inventes metricas tecnicas fuera de este bloque.',
        'Respeta deterministicRules: si hay blockers, no conviertas validacion en accion ejecutable.',
      ],
      deterministicRules,
      resources,
    }),
    ].join('\n');
  }
}

function buildResourceEvidence(
  samples: readonly ResourceMetricSampleItem[],
  costContext: readonly TechnicalCostContextItem[],
): readonly ResourceEvidence[] {
  const costByResource = new Map(costContext.map((item) => [item.externalResourceId, item]));
  const byResource = groupBy(samples, (sample) => sample.externalResourceId);

  return [...byResource.entries()]
    .map(([externalResourceId, resourceSamples]) => {
      const first = resourceSamples[0];
      const cost = costByResource.get(externalResourceId);
      const metrics = buildMetricEvidence(externalResourceId, resourceSamples).slice(0, maxMetricsPerResource);
      return {
        ...(first?.cloudResourceId !== undefined ? { cloudResourceId: first.cloudResourceId } : {}),
        externalResourceId,
        provider: first?.provider ?? 'UNKNOWN',
        ...(cost !== undefined
          ? {
              cost: {
                totalCost: round(cost.totalCost),
                currency: cost.currency,
                metricCount: cost.metricCount,
              },
            }
          : {}),
        technicalEvidenceRefs: metrics.map((metric) => metric.evidenceRef),
        metrics,
      };
    })
    .sort((left, right) => (right.cost?.totalCost ?? 0) - (left.cost?.totalCost ?? 0))
    .slice(0, maxResources);
}

function buildMetricEvidence(
  externalResourceId: string,
  samples: readonly ResourceMetricSampleItem[],
): readonly MetricEvidence[] {
  return [...groupBy(samples, (sample) => sample.metricName).entries()]
    .map(([metricName, metricSamples]) => {
      const values = metricSamples.map((sample) => sample.value);
      const latestSample = [...metricSamples].sort(
        (left, right) => right.sampledAt.getTime() - left.sampledAt.getTime(),
      )[0]!;
      const uniqueDays = new Set(metricSamples.map((sample) => sample.sampledAt.toISOString().slice(0, 10)));

      return {
        metricName,
        ...(latestSample.metricUnit !== undefined ? { metricUnit: latestSample.metricUnit } : {}),
        sampleCount: metricSamples.length,
        coverageDays: uniqueDays.size,
        min: round(Math.min(...values)),
        max: round(Math.max(...values)),
        avg: round(values.reduce((sum, value) => sum + value, 0) / values.length),
        latest: round(latestSample.value),
        latestSampleAt: latestSample.sampledAt.toISOString(),
        evidenceRef: `resource_metric_samples:${externalResourceId}:${metricName}:${latestSample.sampledAt.toISOString()}`,
      };
    })
    .sort((left, right) => right.sampleCount - left.sampleCount);
}

function groupBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
