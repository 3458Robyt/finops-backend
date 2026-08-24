import { type MetricStatistic } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import type { OciMetricDefinition } from './OciSdkContracts.js';

export interface OciCollectionTask {
  readonly definition: OciMetricDefinition;
  readonly statistic: MetricStatistic;
  readonly query: string;
  readonly allowedResourceIds?: ReadonlySet<string>;
  readonly queryCompartmentId?: string;
  readonly compartmentIdInSubtree?: boolean;
  readonly fallbackCompartmentIds?: readonly string[];
}

export interface OciCollectionTaskOptions {
  /** Use one tenancy-level query per metric instead of one query per compartment. */
  readonly subtreeCompartmentId?: string;
}

export function buildOciCollectionTasks(
  definitions: readonly OciMetricDefinition[],
  interval: '1m' | '5m' | '30m' | '1h',
  options: OciCollectionTaskOptions = {},
): readonly OciCollectionTask[] {
  const grouped = new Map<string, {
    readonly definition: OciMetricDefinition;
    readonly statistic: MetricStatistic;
    readonly resourceIds: Set<string>;
    readonly compartmentIds: Set<string>;
  }>();
  const individual: OciCollectionTask[] = [];

  for (const definition of definitions) {
    for (const statistic of definition.statistics ?? ['MEAN']) {
      if (definition.query !== undefined || definition.resourceId.trim() === '') {
        individual.push({
          definition,
          statistic,
          query: definition.query ?? buildOciResourceMetricQuery(definition, statistic, interval),
        });
        continue;
      }

      const key = JSON.stringify([
        definition.regionId ?? '',
        options.subtreeCompartmentId === undefined ? definition.compartmentId : 'TENANCY_SUBTREE',
        definition.namespace,
        definition.metricName,
        statistic,
        definition.unit ?? '',
        nonResourceDimensions(definition.dimensions),
      ]);
      const current = grouped.get(key);
      if (current === undefined) {
        grouped.set(key, {
          definition,
          statistic,
          resourceIds: new Set([definition.resourceId]),
          compartmentIds: new Set([definition.compartmentId]),
        });
      } else {
        current.resourceIds.add(definition.resourceId);
        current.compartmentIds.add(definition.compartmentId);
      }
    }
  }

  const batched = [...grouped.values()].flatMap((group): OciCollectionTask[] => {
    if (group.resourceIds.size === 1) {
      return [{
        definition: group.definition,
        statistic: group.statistic,
        query: buildOciResourceMetricQuery(group.definition, group.statistic, interval),
        ...subtreeQueryOptions(options, group.compartmentIds),
      }];
    }
    return [{
      definition: group.definition,
      statistic: group.statistic,
      query: buildOciGroupedMetricQuery(group.definition, group.statistic, interval),
      allowedResourceIds: group.resourceIds,
      ...subtreeQueryOptions(options, group.compartmentIds),
    }];
  });
  return [...individual, ...batched];
}

function subtreeQueryOptions(
  options: OciCollectionTaskOptions,
  compartmentIds: ReadonlySet<string>,
): Pick<OciCollectionTask, 'queryCompartmentId' | 'compartmentIdInSubtree' | 'fallbackCompartmentIds'> {
  if (options.subtreeCompartmentId === undefined) return {};
  return {
    queryCompartmentId: options.subtreeCompartmentId,
    compartmentIdInSubtree: true,
    fallbackCompartmentIds: [...compartmentIds],
  };
}

export function buildOciGroupedMetricQuery(
  definition: OciMetricDefinition,
  statistic: MetricStatistic,
  interval: '1m' | '5m' | '30m' | '1h' = '30m',
): string {
  const dimensions = nonResourceDimensions(definition.dimensions);
  const selector = Object.entries(dimensions).length === 0
    ? ''
    : `{${Object.entries(dimensions).map(([key, value]) => `${key} = "${escapeMqlValue(value)}"`).join(', ')}}`;
  return `${definition.metricName}[${interval}]${selector}.groupBy(resourceId).${ociStatisticExpression(statistic)}`;
}

export function buildOciResourceMetricQuery(
  definition: OciMetricDefinition,
  statistic: MetricStatistic = 'MEAN',
  interval = '30m',
): string {
  return `${definition.metricName}[${interval}]{resourceId = "${escapeMqlValue(definition.resourceId)}"}.${ociStatisticExpression(statistic)}`;
}

function nonResourceDimensions(
  dimensions: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(dimensions ?? {})
      .filter(([key]) => key !== 'resourceId' && key !== 'resource_id')
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function escapeMqlValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function ociStatisticExpression(statistic: MetricStatistic): string {
  switch (statistic) {
    case 'P50': return 'percentile(0.50)';
    case 'P90': return 'percentile(0.90)';
    case 'P95': return 'percentile(0.95)';
    case 'P99': return 'percentile(0.99)';
    case 'LATEST': return 'last()';
    default: return `${statistic.toLowerCase()}()`;
  }
}
