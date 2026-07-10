import type {
  CloudResourceItem,
  IResourceMetricRepository,
  ResourceMetricSampleItem,
  TechnicalMetricCoverageAggregate,
  TechnicalCostContextItem,
  TechnicalMetricCoverageSampleItem,
  TechnicalMetricSeriesBucket,
} from '../../domain/interfaces/IResourceMetricRepository.js';

export type TechnicalMetricGroup = 'CPU' | 'MEMORY' | 'NETWORK' | 'DISK' | 'SYSTEM' | 'OTHER';
export type TechnicalCostMatchLevel = 'EXACT' | 'SERVICE' | 'NONE';
export type TechnicalMetricBucket = 'auto' | 'raw' | '30m' | 'hour' | 'day';

export interface TechnicalMetricOverviewInput {
  readonly startDate?: Date;
  readonly endDate?: Date;
  readonly externalResourceId?: string;
  readonly metricNames?: readonly string[];
}

export interface TechnicalMetricSeriesInput extends TechnicalMetricOverviewInput {
  readonly bucket?: TechnicalMetricBucket;
  readonly cursor?: string;
  readonly pageSize?: number;
}

export type TechnicalMetricCoverageDayStatus = 'WITH_DATA' | 'NO_DATA';

export interface TechnicalMetricCoverageMetric {
  readonly metricName: string;
  readonly sampleCount: number;
  readonly daysWithData: number;
  readonly expectedDays: number;
  readonly coveragePercent: number;
  readonly minSampledAt?: Date;
  readonly maxSampledAt?: Date;
}

export interface TechnicalMetricCoverageDay {
  readonly date: string;
  readonly sampleCount: number;
  readonly metricCount: number;
  readonly status: TechnicalMetricCoverageDayStatus;
}

export interface TechnicalMetricCoverage {
  readonly rangeStart?: Date;
  readonly rangeEnd?: Date;
  readonly minSampledAt?: Date;
  readonly maxSampledAt?: Date;
  readonly totalSamples: number;
  readonly metricCount: number;
  readonly resourceCount: number;
  readonly expectedDays: number;
  readonly daysWithData: number;
  readonly coveragePercent: number;
  readonly metrics: readonly TechnicalMetricCoverageMetric[];
  readonly days: readonly TechnicalMetricCoverageDay[];
}

export interface TechnicalMetricCatalogItem {
  readonly metricName: string;
  readonly metricUnit?: string;
  readonly group: TechnicalMetricGroup;
  readonly sampleCount: number;
  readonly minSampledAt: Date;
  readonly maxSampledAt: Date;
}

export interface TechnicalMetricKpi {
  readonly id: string;
  readonly label: string;
  readonly group: TechnicalMetricGroup;
  readonly metricNames: readonly string[];
  readonly unit?: string;
  readonly average: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly latest: number;
  readonly latestSampledAt: Date;
  readonly sampleCount: number;
}

export interface TechnicalMetricResourceSummary {
  readonly externalResourceId: string;
  readonly provider: string;
  readonly name?: string;
  readonly serviceName?: string;
  readonly resourceType?: string;
  readonly regionId?: string;
  readonly status?: string;
  readonly metricNames: readonly string[];
  readonly sampleCount: number;
  readonly minSampledAt: Date;
  readonly maxSampledAt: Date;
  readonly cost?: {
    readonly totalCost: number;
    readonly currency: string;
    readonly metricCount: number;
    readonly matchLevel: TechnicalCostMatchLevel;
  };
}

export interface TechnicalMetricOpportunity {
  readonly id: string;
  readonly severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH';
  readonly title: string;
  readonly description: string;
  readonly externalResourceId?: string;
  readonly metricName?: string;
  readonly value?: number;
  readonly unit?: string;
  readonly cost?: number;
  readonly currency?: string;
}

export interface TechnicalMetricsOverview {
  readonly minSampledAt?: Date;
  readonly maxSampledAt?: Date;
  readonly latestSampledAt?: Date;
  readonly resourceCount: number;
  readonly metricCount: number;
  readonly sampleCount: number;
  readonly resources: readonly TechnicalMetricResourceSummary[];
  readonly metrics: readonly TechnicalMetricCatalogItem[];
  readonly kpis: readonly TechnicalMetricKpi[];
  readonly opportunities: readonly TechnicalMetricOpportunity[];
}

export interface TechnicalMetricSeriesPoint {
  readonly bucketStart: Date;
  readonly externalResourceId: string;
  readonly metricName: string;
  readonly metricUnit?: string;
  readonly avg: number;
  readonly min: number;
  readonly max: number;
  readonly latest: number;
  readonly sampleCount: number;
  readonly minSampledAt?: Date;
  readonly maxSampledAt?: Date;
  readonly latestSampledAt?: Date;
}

export interface TechnicalMetricSeriesMeta {
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  readonly returnedPoints: number;
  readonly totalSamples: number;
  readonly queryMs: number;
  readonly bucket: TechnicalMetricSeriesBucket;
  readonly pageSize: number;
}

export interface TechnicalMetricSeriesResult {
  readonly series: readonly TechnicalMetricSeriesPoint[];
  readonly meta: TechnicalMetricSeriesMeta;
}

const maxOverviewSamples = 5000;
const defaultSeriesPageSize = 1000;
const maxSeriesPageSize = 5000;

/**
 * Servicio de aplicacion de metricas tecnicas de recursos cloud.
 *
 * Expone inventario, muestras crudas y agregados analiticos para que el tecnico
 * FinOps pueda evaluar consumo real: CPU, memoria, red, disco y sistema. Estas
 * metricas no salen de FOCUS; FOCUS solo aporta contexto de costo cuando hay
 * una relacion exacta por recurso.
 */
export class TechnicalMetricsService {
  constructor(private readonly repository: IResourceMetricRepository) {}

  public listResources(tenantId: string, limit?: number): Promise<readonly CloudResourceItem[]> {
    return this.repository.listResourcesForTenant(tenantId, this.clampLimit(limit));
  }

  public listMetricSamples(
    tenantId: string,
    limit?: number,
  ): Promise<readonly ResourceMetricSampleItem[]> {
    return this.repository.listMetricSamplesForTenant(tenantId, this.clampLimit(limit));
  }

  public async getOverview(
    tenantId: string,
    input: TechnicalMetricOverviewInput = {},
  ): Promise<TechnicalMetricsOverview> {
    const samples = await this.repository.listMetricSamplesForTenantByFilter(tenantId, {
      ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
      ...(input.externalResourceId !== undefined ? { externalResourceId: input.externalResourceId } : {}),
      ...(input.metricNames !== undefined ? { metricNames: input.metricNames } : {}),
      limit: maxOverviewSamples,
    });
    const resources = await this.repository.listResourcesForTenant(tenantId, 200);
    const resourceIds = unique(samples.map((sample) => sample.externalResourceId));
    const costContext = await this.repository.listCostContextForResources(tenantId, resourceIds);

    return buildOverview(samples, resources, costContext);
  }

  public async getSeries(
    tenantId: string,
    input: TechnicalMetricSeriesInput = {},
  ): Promise<TechnicalMetricSeriesResult> {
    const startedAt = Date.now();
    const bucket = resolveRequestedBucket(input.bucket ?? 'auto');
    const pageSize = this.clampSeriesPageSize(input.pageSize);
    const result = await this.repository.listMetricSeriesForTenant(tenantId, {
      ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
      ...(input.externalResourceId !== undefined ? { externalResourceId: input.externalResourceId } : {}),
      ...(input.metricNames !== undefined ? { metricNames: input.metricNames } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      bucket,
      pageSize,
    });

    return {
      series: result.points,
      meta: {
        hasMore: result.hasMore,
        ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
        returnedPoints: result.points.length,
        totalSamples: result.totalSamples,
        queryMs: Date.now() - startedAt,
        bucket,
        pageSize,
      },
    };
  }

  public async getCoverage(
    tenantId: string,
    input: TechnicalMetricOverviewInput = {},
  ): Promise<TechnicalMetricCoverage> {
    if (this.repository.getMetricCoverageForTenant !== undefined) {
      const aggregate = await this.repository.getMetricCoverageForTenant(tenantId, {
        ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
        ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
        ...(input.externalResourceId !== undefined ? { externalResourceId: input.externalResourceId } : {}),
      });

      return buildCoverageFromAggregate(aggregate, input.startDate, input.endDate);
    }

    const samples = await this.repository.listMetricCoverageSamplesForTenant(tenantId, {
      ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
      ...(input.externalResourceId !== undefined ? { externalResourceId: input.externalResourceId } : {}),
    });

    return buildCoverage(samples, input.startDate, input.endDate);
  }

  private clampLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) {
      return 50;
    }

    return Math.min(200, Math.max(1, Math.floor(limit)));
  }

  private clampSeriesPageSize(pageSize: number | undefined): number {
    if (pageSize === undefined || !Number.isFinite(pageSize)) {
      return defaultSeriesPageSize;
    }

    return Math.min(maxSeriesPageSize, Math.max(1, Math.floor(pageSize)));
  }
}

function buildOverview(
  samples: readonly ResourceMetricSampleItem[],
  resources: readonly CloudResourceItem[],
  costContext: readonly TechnicalCostContextItem[],
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
  const resourceMap = new Map(resources.map((resource) => [resource.externalResourceId, resource]));
  const costMap = new Map(costContext.map((item) => [item.externalResourceId, item]));
  const resourceSummaries = buildResourceSummaries(samples, resourceMap, costMap);
  const metrics = buildMetricCatalog(samples);
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
    const existing = grouped.get(sample.externalResourceId) ?? [];
    existing.push(sample);
    grouped.set(sample.externalResourceId, existing);
  }

  return [...grouped.entries()].map(([externalResourceId, resourceSamples]) => {
    const resource = resourceMap.get(externalResourceId);
    const cost = costMap.get(externalResourceId);

    return {
      externalResourceId,
      provider: resourceSamples[0]?.provider ?? resource?.provider ?? 'UNKNOWN',
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

function buildMetricCatalog(samples: readonly ResourceMetricSampleItem[]): readonly TechnicalMetricCatalogItem[] {
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

    return {
      metricName: first.metricName,
      ...(metricUnit !== undefined ? { metricUnit } : {}),
      group: classifyMetric(first.metricName),
      sampleCount: metricSamples.length,
      minSampledAt: minDate(metricSamples.map((sample) => sample.sampledAt)) ?? first.sampledAt,
      maxSampledAt: maxDate(metricSamples.map((sample) => sample.sampledAt)) ?? first.sampledAt,
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
    const resourceSamples = samples.filter((sample) => sample.externalResourceId === resource.externalResourceId);
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

function buildCoverage(
  samples: readonly TechnicalMetricCoverageSampleItem[],
  requestedStart: Date | undefined,
  requestedEnd: Date | undefined,
): TechnicalMetricCoverage {
  const minSampledAt = minDate(samples.map((sample) => sample.sampledAt));
  const maxSampledAt = maxDate(samples.map((sample) => sample.sampledAt));
  const rangeStart = requestedStart ?? minSampledAt;
  const rangeEnd = requestedEnd ?? maxSampledAt;
  const expectedDays = countDays(rangeStart, rangeEnd);
  const dayBuckets = new Map<string, TechnicalMetricCoverageSampleItem[]>();
  const metricBuckets = new Map<string, TechnicalMetricCoverageSampleItem[]>();

  for (const sample of samples) {
    const day = toUtcDay(sample.sampledAt);
    const daySamples = dayBuckets.get(day) ?? [];
    daySamples.push(sample);
    dayBuckets.set(day, daySamples);

    const metricSamples = metricBuckets.get(sample.metricName) ?? [];
    metricSamples.push(sample);
    metricBuckets.set(sample.metricName, metricSamples);
  }

  const days = buildCoverageDays(rangeStart, rangeEnd, dayBuckets);
  const daysWithData = days.filter((day) => day.status === 'WITH_DATA').length;

  return {
    ...(rangeStart !== undefined ? { rangeStart } : {}),
    ...(rangeEnd !== undefined ? { rangeEnd } : {}),
    ...(minSampledAt !== undefined ? { minSampledAt } : {}),
    ...(maxSampledAt !== undefined ? { maxSampledAt } : {}),
    totalSamples: samples.length,
    metricCount: metricBuckets.size,
    resourceCount: unique(samples.map((sample) => sample.externalResourceId)).length,
    expectedDays,
    daysWithData,
    coveragePercent: expectedDays === 0 ? 0 : round((daysWithData / expectedDays) * 100),
    metrics: [...metricBuckets.entries()].map(([metricName, metricSamples]) => {
      const metricDays = new Set(metricSamples.map((sample) => toUtcDay(sample.sampledAt)));
      const metricMinSampledAt = minDate(metricSamples.map((sample) => sample.sampledAt));
      const metricMaxSampledAt = maxDate(metricSamples.map((sample) => sample.sampledAt));

      return {
        metricName,
        sampleCount: metricSamples.length,
        daysWithData: metricDays.size,
        expectedDays,
        coveragePercent: expectedDays === 0 ? 0 : round((metricDays.size / expectedDays) * 100),
        ...(metricMinSampledAt !== undefined ? { minSampledAt: metricMinSampledAt } : {}),
        ...(metricMaxSampledAt !== undefined ? { maxSampledAt: metricMaxSampledAt } : {}),
      };
    }).sort((left, right) => right.sampleCount - left.sampleCount || left.metricName.localeCompare(right.metricName)),
    days,
  };
}

function buildCoverageFromAggregate(
  aggregate: TechnicalMetricCoverageAggregate,
  rangeStart: Date | undefined,
  rangeEnd: Date | undefined,
): TechnicalMetricCoverage {
  const expectedDays = countDays(rangeStart, rangeEnd);
  const days = buildCoverageDaysFromAggregate(aggregate.days, rangeStart, rangeEnd);
  const daysWithData = days.filter((day) => day.status === 'WITH_DATA').length;

  return {
    ...(rangeStart !== undefined ? { rangeStart } : {}),
    ...(rangeEnd !== undefined ? { rangeEnd } : {}),
    ...(aggregate.minSampledAt !== undefined ? { minSampledAt: aggregate.minSampledAt } : {}),
    ...(aggregate.maxSampledAt !== undefined ? { maxSampledAt: aggregate.maxSampledAt } : {}),
    totalSamples: aggregate.totalSamples,
    metricCount: aggregate.metricCount,
    resourceCount: aggregate.resourceCount,
    expectedDays,
    daysWithData,
    coveragePercent: expectedDays === 0 ? 0 : round((daysWithData / expectedDays) * 100),
    metrics: aggregate.metrics.map((metric) => ({
      metricName: metric.metricName,
      sampleCount: metric.sampleCount,
      daysWithData: metric.daysWithData,
      expectedDays,
      coveragePercent: expectedDays === 0 ? 0 : round((metric.daysWithData / expectedDays) * 100),
      ...(metric.minSampledAt !== undefined ? { minSampledAt: metric.minSampledAt } : {}),
      ...(metric.maxSampledAt !== undefined ? { maxSampledAt: metric.maxSampledAt } : {}),
    })).sort((left, right) => right.sampleCount - left.sampleCount || left.metricName.localeCompare(right.metricName)),
    days,
  };
}

function buildCoverageDaysFromAggregate(
  aggregateDays: TechnicalMetricCoverageAggregate['days'],
  rangeStart: Date | undefined,
  rangeEnd: Date | undefined,
): readonly TechnicalMetricCoverageDay[] {
  const byDate = new Map(aggregateDays.map((day) => [day.date, day]));
  if (rangeStart === undefined || rangeEnd === undefined) {
    return aggregateDays.map((day) => ({
      ...day,
      status: 'WITH_DATA' as const,
    }));
  }

  const days: TechnicalMetricCoverageDay[] = [];
  const cursor = startOfUtcDay(rangeStart);
  const end = startOfUtcDay(rangeEnd);
  while (cursor.getTime() <= end.getTime()) {
    const date = toUtcDay(cursor);
    const aggregateDay = byDate.get(date);
    days.push({
      date,
      sampleCount: aggregateDay?.sampleCount ?? 0,
      metricCount: aggregateDay?.metricCount ?? 0,
      status: aggregateDay === undefined ? 'NO_DATA' : 'WITH_DATA',
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function buildCoverageDays(
  rangeStart: Date | undefined,
  rangeEnd: Date | undefined,
  dayBuckets: ReadonlyMap<string, readonly TechnicalMetricCoverageSampleItem[]>,
): readonly TechnicalMetricCoverageDay[] {
  if (rangeStart === undefined || rangeEnd === undefined) {
    return [...dayBuckets.entries()].map(([date, daySamples]) => ({
      date,
      sampleCount: daySamples.length,
      metricCount: unique(daySamples.map((sample) => sample.metricName)).length,
      status: 'WITH_DATA' as const,
    })).sort((left, right) => left.date.localeCompare(right.date));
  }

  const days: TechnicalMetricCoverageDay[] = [];
  const cursor = startOfUtcDay(rangeStart);
  const end = startOfUtcDay(rangeEnd);

  while (cursor.getTime() <= end.getTime()) {
    const date = toUtcDay(cursor);
    const daySamples = dayBuckets.get(date) ?? [];
    days.push({
      date,
      sampleCount: daySamples.length,
      metricCount: unique(daySamples.map((sample) => sample.metricName)).length,
      status: daySamples.length > 0 ? 'WITH_DATA' : 'NO_DATA',
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return days;
}

function countDays(rangeStart: Date | undefined, rangeEnd: Date | undefined): number {
  if (rangeStart === undefined || rangeEnd === undefined || rangeEnd < rangeStart) {
    return 0;
  }

  const start = startOfUtcDay(rangeStart);
  const end = startOfUtcDay(rangeEnd);
  return Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
}

function startOfUtcDay(value: Date): Date {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function toUtcDay(value: Date): string {
  return startOfUtcDay(value).toISOString().slice(0, 10);
}

function resolveRequestedBucket(requested: TechnicalMetricBucket): TechnicalMetricSeriesBucket {
  return requested === 'auto' ? 'raw' : requested;
}

function classifyMetric(metricName: string): TechnicalMetricGroup {
  const normalized = metricName.toLowerCase();

  if (normalized.includes('cpu')) {
    return 'CPU';
  }
  if (normalized.includes('memory')) {
    return 'MEMORY';
  }
  if (normalized.includes('network')) {
    return 'NETWORK';
  }
  if (normalized.includes('disk') || normalized.includes('iops')) {
    return 'DISK';
  }
  if (normalized.includes('load')) {
    return 'SYSTEM';
  }

  return 'OTHER';
}

function normalizeUnit(metricName: string, unit: string | undefined): string | undefined {
  if (unit !== undefined) {
    return unit;
  }

  const normalized = metricName.toLowerCase();
  if (normalized.includes('utilization')) {
    return '%';
  }
  if (normalized.includes('bytes')) {
    return 'Bytes';
  }
  if (normalized.includes('iops')) {
    return 'IOPS';
  }

  return undefined;
}

function minDate(values: readonly Date[]): Date | undefined {
  if (values.length === 0) {
    return undefined;
  }

  return new Date(Math.min(...values.map((value) => value.getTime())));
}

function maxDate(values: readonly Date[]): Date | undefined {
  if (values.length === 0) {
    return undefined;
  }

  return new Date(Math.max(...values.map((value) => value.getTime())));
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
