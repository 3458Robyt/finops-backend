import type {
  CloudResourceItem,
  ResourceMetricSampleItem,
  TechnicalCostContextItem,
} from '../../../domain/interfaces/IResourceMetricRepository.js';
import type {
  TechnicalMetricCatalogItem,
  TechnicalMetricKpi,
  TechnicalMetricOpportunity,
  TechnicalMetricGroup,
  TechnicalMetricResourceSummary,
  TechnicalMetricsOverview,
} from './TechnicalMetricsContracts.js';
import { METRIC_STATISTICS } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import {
  average,
  classifyMetric,
  maxDate,
  minDate,
  normalizeUnit,
  resourceIdentity,
  round,
  unique,
} from './technicalMetricMath.js';

export function buildOverview(
  samples: readonly ResourceMetricSampleItem[],
  resources: readonly CloudResourceItem[],
  costContext: readonly TechnicalCostContextItem[],
  availableStatisticsByMetric?: ReadonlyMap<string, ReadonlySet<string>>,
): TechnicalMetricsOverview {
  if (samples.length === 0) {
    return {
      resourceCount: 0,
      metricCount: 0,
      sampleCount: 0,
      resources: [],
      metrics: [],
      kpis: [],
      opportunities: [],
    };
  }

  const minSampledAt = minDate(samples.map((sample) => sample.sampledAt));
  const maxSampledAt = maxDate(samples.map((sample) => sample.sampledAt));
  const latestSampledAt = maxSampledAt;
  const resourceMap = new Map(resources.map((resource) => [resourceIdentity(resource), resource]));
  const costMap = new Map(costContext.map((item) => [resourceIdentity(item), item]));
  const resourceSummaries = buildResourceSummaries(samples, resourceMap, costMap);
  const metrics = buildMetricCatalog(samples, availableStatisticsByMetric);
  const kpis = buildKpis(samples);

  return {
    ...(minSampledAt !== undefined ? { minSampledAt } : {}),
    ...(maxSampledAt !== undefined ? { maxSampledAt } : {}),
    ...(latestSampledAt !== undefined ? { latestSampledAt } : {}),
    resourceCount: resourceSummaries.length,
    metricCount: metrics.length,
    sampleCount: samples.length,
    resources: resourceSummaries,
    metrics,
    kpis,
    opportunities: buildOpportunities(samples, resourceSummaries, latestSampledAt),
  };
}

function buildResourceSummaries(
  samples: readonly ResourceMetricSampleItem[],
  resourceMap: ReadonlyMap<string, CloudResourceItem>,
  costMap: ReadonlyMap<string, TechnicalCostContextItem>,
): readonly TechnicalMetricResourceSummary[] {
  const grouped = new Map<string, ResourceMetricSampleItem[]>();

  for (const sample of samples) {
    const existing = grouped.get(resourceIdentity(sample)) ?? [];
    existing.push(sample);
    grouped.set(resourceIdentity(sample), existing);
  }

  return [...grouped.entries()].map(([, resourceSamples]) => {
    const firstSample = resourceSamples[0]!;
    const resource = resourceMap.get(resourceIdentity(firstSample));
    const cost = costMap.get(resourceIdentity(firstSample));
    const externalResourceId = firstSample.externalResourceId;

    return {
      ...(firstSample.cloudResourceId !== undefined
        ? { cloudResourceId: firstSample.cloudResourceId }
        : resource?.id !== undefined ? { cloudResourceId: resource.id } : {}),
      ...(firstSample.cloudConnectionId !== undefined
        ? { cloudConnectionId: firstSample.cloudConnectionId }
        : resource?.cloudConnectionId !== undefined ? { cloudConnectionId: resource.cloudConnectionId } : {}),
      externalResourceId,
      provider: firstSample.provider ?? resource?.provider ?? 'UNKNOWN',
      ...(resource?.name !== undefined ? { name: resource.name } : {}),
      ...(resource?.serviceName !== undefined ? { serviceName: resource.serviceName } : {}),
      ...(resource?.resourceType !== undefined ? { resourceType: resource.resourceType } : {}),
      ...(resource?.regionId !== undefined ? { regionId: resource.regionId } : {}),
      ...(resource?.status !== undefined ? { status: resource.status } : {}),
      metricNames: unique(resourceSamples.map((sample) => sample.metricName)).sort(),
      sampleCount: resourceSamples.length,
      minSampledAt: minDate(resourceSamples.map((sample) => sample.sampledAt)) ?? resourceSamples[0]!.sampledAt,
      maxSampledAt: maxDate(resourceSamples.map((sample) => sample.sampledAt)) ?? resourceSamples[0]!.sampledAt,
      ...(cost !== undefined
        ? {
            cost: {
              totalCost: round(cost.totalCost),
              currency: cost.currency,
              metricCount: cost.metricCount,
              matchLevel: 'EXACT' as const,
            },
          }
        : {}),
    };
  }).sort((left, right) => right.maxSampledAt.getTime() - left.maxSampledAt.getTime());
}

function buildMetricCatalog(
  samples: readonly ResourceMetricSampleItem[],
  availableStatisticsByMetric?: ReadonlyMap<string, ReadonlySet<string>>,
): readonly TechnicalMetricCatalogItem[] {
  const grouped = new Map<string, ResourceMetricSampleItem[]>();

  for (const sample of samples) {
    const key = `${sample.metricName}\u0000${sample.metricUnit ?? ''}`;
    const existing = grouped.get(key) ?? [];
    existing.push(sample);
    grouped.set(key, existing);
  }

  return [...grouped.values()].map((metricSamples) => {
    const first = metricSamples[0]!;
    const metricUnit = normalizeUnit(first.metricName, first.metricUnit);

    const availableStatistics = availableStatisticsByMetric?.get(first.metricName)
      ?? new Set(metricSamples.map((sample) => sample.statistic));

    return {
      metricName: first.metricName,
      ...(metricUnit !== undefined ? { metricUnit } : {}),
      group: classifyMetric(first.metricName),
      sampleCount: metricSamples.length,
      minSampledAt: minDate(metricSamples.map((sample) => sample.sampledAt)) ?? first.sampledAt,
      maxSampledAt: maxDate(metricSamples.map((sample) => sample.sampledAt)) ?? first.sampledAt,
      availableStatistics: METRIC_STATISTICS.filter((statistic) => availableStatistics.has(statistic)),
    };
  }).sort((left, right) => left.group.localeCompare(right.group) || left.metricName.localeCompare(right.metricName));
}

function buildKpis(samples: readonly ResourceMetricSampleItem[]): readonly TechnicalMetricKpi[] {
  const groups: readonly { readonly id: string; readonly label: string; readonly group: TechnicalMetricGroup }[] = [
    { id: 'cpu', label: 'CPU', group: 'CPU' },
    { id: 'memory', label: 'Memoria', group: 'MEMORY' },
    { id: 'network', label: 'Red', group: 'NETWORK' },
    { id: 'disk', label: 'Disco', group: 'DISK' },
    { id: 'system', label: 'Sistema', group: 'SYSTEM' },
  ];

  return groups.flatMap((group) => {
    const groupSamples = samples.filter((sample) => classifyMetric(sample.metricName) === group.group);
    if (groupSamples.length === 0) {
      return [];
    }

    const latest = [...groupSamples].sort((left, right) => right.sampledAt.getTime() - left.sampledAt.getTime())[0]!;
    const values = groupSamples.map((sample) => sample.value);
    const unit = normalizeUnit(latest.metricName, latest.metricUnit);

    return [{
      id: group.id,
      label: group.label,
      group: group.group,
      metricNames: unique(groupSamples.map((sample) => sample.metricName)).sort(),
      ...(unit !== undefined ? { unit } : {}),
      average: round(average(values)),
      minimum: round(Math.min(...values)),
      maximum: round(Math.max(...values)),
      latest: round(latest.value),
      latestSampledAt: latest.sampledAt,
      sampleCount: groupSamples.length,
    }];
  });
}

function buildOpportunities(
  samples: readonly ResourceMetricSampleItem[],
  resources: readonly TechnicalMetricResourceSummary[],
  latestSampledAt: Date | undefined,
): readonly TechnicalMetricOpportunity[] {
  const opportunities: TechnicalMetricOpportunity[] = [];

  for (const resource of resources) {
    const resourceSamples = samples.filter((sample) => resourceIdentity(sample) === resourceIdentity(resource));
    const cpuSamples = resourceSamples.filter((sample) => classifyMetric(sample.metricName) === 'CPU');
    const memorySamples = resourceSamples.filter((sample) => classifyMetric(sample.metricName) === 'MEMORY');

    if (cpuSamples.length > 0) {
      const avgCpu = average(cpuSamples.map((sample) => sample.value));
      if (avgCpu < 15) {
        opportunities.push({
          id: `${resource.externalResourceId}:low-cpu`,
          severity: resource.cost !== undefined && resource.cost.totalCost > 0 ? 'HIGH' : 'MEDIUM',
          title: 'Oportunidad por baja utilizacion de CPU',
          description: 'El recurso muestra CPU promedio baja. Revisar rightsizing, apagado programado o cambio de shape antes de ejecutar.',
          externalResourceId: resource.externalResourceId,
          ...(resource.cloudResourceId !== undefined ? { cloudResourceId: resource.cloudResourceId } : {}),
          metricName: 'CPU',
          value: round(avgCpu),
          unit: '%',
          ...(resource.cost !== undefined ? { cost: resource.cost.totalCost, currency: resource.cost.currency } : {}),
        });
      }
    }

    if (memorySamples.length > 0) {
      const maxMemory = Math.max(...memorySamples.map((sample) => sample.value));
      if (maxMemory > 85) {
        opportunities.push({
          id: `${resource.externalResourceId}:high-memory`,
          severity: 'MEDIUM',
          title: 'Memoria con picos altos',
          description: 'La memoria supera 85%. Antes de reducir capacidad, validar comportamiento de la aplicacion y ventanas de carga.',
          externalResourceId: resource.externalResourceId,
          ...(resource.cloudResourceId !== undefined ? { cloudResourceId: resource.cloudResourceId } : {}),
          metricName: 'Memoria',
          value: round(maxMemory),
          unit: '%',
        });
      }
    }

    if (resource.serviceName === undefined || resource.resourceType === undefined) {
      opportunities.push({
        id: `${resource.externalResourceId}:missing-inventory`,
        severity: 'INFO',
        title: 'Metrica tecnica sin inventario normalizado',
        description: 'Hay muestras reales para este recurso, pero falta asociarlas a cloud_resources. Esto limita el cruce exacto con servicio, region y estado.',
        externalResourceId: resource.externalResourceId,
        ...(resource.cloudResourceId !== undefined ? { cloudResourceId: resource.cloudResourceId } : {}),
      });
    }
  }

  if (latestSampledAt !== undefined) {
    const staleThresholdMs = 48 * 60 * 60 * 1000;
    const now = Date.now();
    if (now - latestSampledAt.getTime() > staleThresholdMs) {
      opportunities.push({
        id: 'stale-metrics',
        severity: 'MEDIUM',
        title: 'Metricas tecnicas desactualizadas',
        description: 'La ultima muestra tecnica supera 48 horas. Validar scheduler, credenciales METRICS_READ o permisos del proveedor.',
        value: Math.round((now - latestSampledAt.getTime()) / (60 * 60 * 1000)),
        unit: 'h',
      });
    }
  }

  return opportunities.slice(0, 8);
}
