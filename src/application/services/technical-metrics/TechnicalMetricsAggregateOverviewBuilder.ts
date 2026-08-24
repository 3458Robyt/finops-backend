import type {
  CloudResourceItem,
  TechnicalCostContextItem,
  TechnicalMetricSummaryItem,
} from '../../../domain/interfaces/IResourceMetricRepository.js';
import type {
  TechnicalMetricCatalogItem,
  TechnicalMetricKpi,
  TechnicalMetricOpportunity,
  TechnicalMetricResourceSummary,
  TechnicalMetricsOverview,
} from './TechnicalMetricsContracts.js';
import {
  classifyMetric,
  maxDate,
  minDate,
  normalizeUnit,
  resourceIdentity,
  round,
  unique,
} from './technicalMetricMath.js';

/** Builds the overview from SQL aggregates instead of loading a capped sample list into Node. */
export function buildOverviewFromSummaries(
  summaries: readonly TechnicalMetricSummaryItem[],
  resources: readonly CloudResourceItem[],
  costs: readonly TechnicalCostContextItem[],
  availableStatisticsByMetric: ReadonlyMap<string, ReadonlySet<string>>,
  catalogSummaries: readonly TechnicalMetricSummaryItem[] = summaries,
): TechnicalMetricsOverview {
  if (summaries.length === 0 && catalogSummaries.length === 0) {
    return { resourceCount: 0, metricCount: 0, sampleCount: 0, resources: [], metrics: [], kpis: [], opportunities: [] };
  }

  const resourceMap = new Map(resources.map((resource) => [resource.id, resource]));
  const costMap = new Map(costs.map((cost) => [resourceIdentity(cost), cost]));
  const resourcesSummary = buildResourceSummaries(summaries, resourceMap, costMap);
  const metrics = buildMetricCatalog(catalogSummaries, availableStatisticsByMetric);
  const kpis = buildKpis(summaries);
  const latestSampledAt = maxDate(summaries.map((row) => row.latestSampledAt));

  const minSampledAt = minDate(summaries.map((row) => row.firstSampledAt));
  return {
    ...(minSampledAt !== undefined ? { minSampledAt } : {}),
    ...(latestSampledAt !== undefined ? { maxSampledAt: latestSampledAt, latestSampledAt } : {}),
    resourceCount: resourcesSummary.length,
    metricCount: metrics.length,
    sampleCount: summaries.reduce((total, row) => total + row.sampleCount, 0),
    resources: resourcesSummary,
    metrics,
    kpis,
    opportunities: buildOpportunities(summaries, resourcesSummary, latestSampledAt),
  };
}

function buildResourceSummaries(
  rows: readonly TechnicalMetricSummaryItem[],
  resources: ReadonlyMap<string, CloudResourceItem>,
  costs: ReadonlyMap<string, TechnicalCostContextItem>,
): readonly TechnicalMetricResourceSummary[] {
  const grouped = groupBy(rows, resourceIdentity);
  return [...grouped.values()].map((resourceRows) => {
    const first = resourceRows[0]!;
    const resource = first.cloudResourceId === undefined ? undefined : resources.get(first.cloudResourceId);
    const cost = costs.get(resourceIdentity(first));
    return {
      ...(first.cloudResourceId !== undefined ? { cloudResourceId: first.cloudResourceId } : {}),
      ...(first.cloudConnectionId !== undefined ? { cloudConnectionId: first.cloudConnectionId } : {}),
      externalResourceId: first.externalResourceId,
      provider: first.provider,
      ...(resource?.name !== undefined ? { name: resource.name } : {}),
      ...(resource?.serviceName ?? first.serviceName ? { serviceName: resource?.serviceName ?? first.serviceName } : {}),
      ...(resource?.resourceType ?? first.resourceType ? { resourceType: resource?.resourceType ?? first.resourceType } : {}),
      ...(resource?.regionId !== undefined ? { regionId: resource.regionId } : {}),
      ...(resource?.status !== undefined ? { status: resource.status } : {}),
      metricNames: unique(resourceRows.map((row) => row.metricName)).sort(),
      sampleCount: resourceRows.reduce((total, row) => total + row.sampleCount, 0),
      minSampledAt: minDate(resourceRows.map((row) => row.firstSampledAt)) ?? first.firstSampledAt,
      maxSampledAt: maxDate(resourceRows.map((row) => row.latestSampledAt)) ?? first.latestSampledAt,
      ...(cost !== undefined ? {
        cost: {
          totalCost: round(cost.totalCost),
          currency: cost.currency,
          metricCount: cost.metricCount,
          matchLevel: 'EXACT' as const,
        },
      } : {}),
    };
  }).sort((left, right) => right.maxSampledAt.getTime() - left.maxSampledAt.getTime());
}

function buildMetricCatalog(
  rows: readonly TechnicalMetricSummaryItem[],
  available: ReadonlyMap<string, ReadonlySet<string>>,
): readonly TechnicalMetricCatalogItem[] {
  return [...groupBy(rows, (row) => row.metricName).values()].map((metricRows) => {
    const first = metricRows[0]!;
    const metricUnit = normalizeUnit(first.metricName, first.metricUnit);
    const availableStatistics = [...(available.get(first.metricName) ?? new Set([first.statistic]))] as NonNullable<TechnicalMetricCatalogItem['availableStatistics']>;
    return {
      metricName: first.metricName,
      ...(metricUnit !== undefined ? { metricUnit } : {}),
      group: classifyMetric(first.metricName),
      sampleCount: metricRows.reduce((total, row) => total + row.sampleCount, 0),
      minSampledAt: minDate(metricRows.map((row) => row.firstSampledAt)) ?? first.firstSampledAt,
      maxSampledAt: maxDate(metricRows.map((row) => row.latestSampledAt)) ?? first.latestSampledAt,
      availableStatistics,
    };
  }).sort((left, right) => left.group.localeCompare(right.group) || left.metricName.localeCompare(right.metricName));
}

function buildKpis(rows: readonly TechnicalMetricSummaryItem[]): readonly TechnicalMetricKpi[] {
  const groups = new Map<string, TechnicalMetricSummaryItem[]>();
  for (const row of rows) {
    const group = classifyMetric(row.metricName);
    const current = groups.get(group) ?? [];
    current.push(row);
    groups.set(group, current);
  }
  return [...groups.entries()].map(([group, groupRows]) => {
    const sampleCount = groupRows.reduce((total, row) => total + row.sampleCount, 0);
    const latest = [...groupRows].sort((left, right) => right.latestSampledAt.getTime() - left.latestSampledAt.getTime())[0]!;
    const unit = normalizeUnit(latest.metricName, latest.metricUnit);
    return {
      id: group.toLowerCase(),
      label: group === 'MEMORY' ? 'Memoria' : group === 'NETWORK' ? 'Red' : group === 'DISK' ? 'Disco' : group,
      group: group as TechnicalMetricKpi['group'],
      metricNames: unique(groupRows.map((row) => row.metricName)).sort(),
      ...(unit !== undefined ? { unit } : {}),
      average: round(groupRows.reduce((total, row) => total + row.avg * row.sampleCount, 0) / Math.max(sampleCount, 1)),
      minimum: round(Math.min(...groupRows.map((row) => row.min))),
      maximum: round(Math.max(...groupRows.map((row) => row.max))),
      latest: round(latest.latest),
      latestSampledAt: latest.latestSampledAt,
      sampleCount,
    };
  });
}

function buildOpportunities(
  rows: readonly TechnicalMetricSummaryItem[],
  resources: readonly TechnicalMetricResourceSummary[],
  latestSampledAt: Date | undefined,
): readonly TechnicalMetricOpportunity[] {
  const opportunities: TechnicalMetricOpportunity[] = [];
  for (const resource of resources) {
    const resourceRows = rows.filter((row) => resourceIdentity(row) === resourceIdentity(resource));
    const cpu = resourceRows.filter((row) => classifyMetric(row.metricName) === 'CPU');
    const memory = resourceRows.filter((row) => classifyMetric(row.metricName) === 'MEMORY');
    if (cpu.length > 0) {
      const average = cpu.reduce((total, row) => total + row.avg * row.sampleCount, 0) / Math.max(1, cpu.reduce((total, row) => total + row.sampleCount, 0));
      if (average < 15) opportunities.push({ id: `${resource.externalResourceId}:low-cpu`, severity: resource.cost?.totalCost ? 'HIGH' : 'MEDIUM', title: 'Oportunidad por baja utilización de CPU', description: 'La CPU promedio es baja. Revisar rightsizing, apagado programado o cambio de shape antes de ejecutar.', externalResourceId: resource.externalResourceId, ...(resource.cloudResourceId ? { cloudResourceId: resource.cloudResourceId } : {}), metricName: 'CPU', value: round(average), unit: '%' });
    }
    const maxMemory = memory.length > 0 ? Math.max(...memory.map((row) => row.max)) : undefined;
    if (maxMemory !== undefined && maxMemory > 85) opportunities.push({ id: `${resource.externalResourceId}:high-memory`, severity: 'MEDIUM', title: 'Memoria con picos altos', description: 'La memoria supera 85%. Validar el comportamiento de la aplicación antes de reducir capacidad.', externalResourceId: resource.externalResourceId, ...(resource.cloudResourceId ? { cloudResourceId: resource.cloudResourceId } : {}), metricName: 'Memoria', value: round(maxMemory), unit: '%' });
    if (resource.serviceName === undefined || resource.resourceType === undefined) opportunities.push({ id: `${resource.externalResourceId}:missing-inventory`, severity: 'INFO', title: 'Métrica técnica sin inventario normalizado', description: 'Existen métricas reales, pero falta asociarlas a cloud_resources para cruzarlas con costo y estado.', externalResourceId: resource.externalResourceId, ...(resource.cloudResourceId ? { cloudResourceId: resource.cloudResourceId } : {}) });
  }
  if (latestSampledAt !== undefined && Date.now() - latestSampledAt.getTime() > 48 * 60 * 60 * 1000) opportunities.push({ id: 'stale-metrics', severity: 'MEDIUM', title: 'Métricas técnicas desactualizadas', description: 'La última muestra supera 48 horas. Validar scheduler, credenciales y permisos del proveedor.', value: Math.round((Date.now() - latestSampledAt.getTime()) / (60 * 60 * 1000)), unit: 'h' });
  return opportunities.slice(0, 8);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const current = groups.get(key(item)) ?? [];
    current.push(item);
    groups.set(key(item), current);
  }
  return groups;
}
