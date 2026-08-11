import type {
  CloudResourceItem,
  IResourceMetricRepository,
  ResourceMetricSampleItem,
} from '../../domain/interfaces/IResourceMetricRepository.js';
import { evaluateTechnicalOptimizationRules } from './ai/TechnicalOptimizationRuleEngine.js';
import type {
  TechnicalMetricCoverage,
  TechnicalMetricOverviewInput,
  TechnicalMetricSeriesInput,
  TechnicalMetricSeriesResult,
  TechnicalMetricsOverview,
  TechnicalResourceSummary,
} from './technical-metrics/TechnicalMetricsContracts.js';
import {
  buildCoverage,
  buildCoverageFromAggregate,
} from './technical-metrics/TechnicalMetricCoverageBuilder.js';
import { buildOverview } from './technical-metrics/TechnicalMetricsOverviewBuilder.js';
import {
  resolveRequestedBucket,
  unique,
} from './technical-metrics/technicalMetricMath.js';

export type * from './technical-metrics/TechnicalMetricsContracts.js';

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

  public async getResource(tenantId: string, externalResourceId: string, cloudResourceId?: string): Promise<CloudResourceItem | undefined> {
    if (cloudResourceId !== undefined && this.repository.getResourceForTenantById !== undefined) {
      const resource = await this.repository.getResourceForTenantById(tenantId, cloudResourceId);
      return resource?.externalResourceId === externalResourceId ? resource : undefined;
    }
    const resources = await this.repository.listResourcesForTenant(tenantId, 200);
    return resources.find((resource) => resource.externalResourceId === externalResourceId
      && (cloudResourceId === undefined || resource.id === cloudResourceId));
  }

  public async getResourceSummary(
    tenantId: string,
    externalResourceId: string,
    cloudResourceId?: string,
  ): Promise<TechnicalResourceSummary | undefined> {
    const resource = await this.getResource(tenantId, externalResourceId, cloudResourceId);
    if (resource === undefined) {
      return undefined;
    }

    const [metrics, coverage, costs] = await Promise.all([
      this.repository.listMetricSummariesForTenant(tenantId, {
        externalResourceIds: [externalResourceId],
        ...(cloudResourceId !== undefined ? { cloudResourceIds: [cloudResourceId] } : {}),
        limit: 100,
      }),
      this.getCoverage(tenantId, { externalResourceId, ...(cloudResourceId !== undefined ? { cloudResourceId } : {}) }),
      this.repository.listCostContextForResources(tenantId, [externalResourceId], cloudResourceId === undefined ? undefined : [cloudResourceId]),
    ]);
    const evaluation = evaluateTechnicalOptimizationRules({
      summaries: metrics,
      referenceDate: new Date(),
    }).find((item) => item.externalResourceId === externalResourceId
      && (cloudResourceId === undefined || item.cloudResourceId === cloudResourceId));

    return {
      resource,
      metrics,
      coverage,
      evidence: evaluation === undefined
        ? {
            strength: 'LOW',
            readiness: 'VALIDATION_ONLY',
            blockers: ['NO_TECHNICAL_EVIDENCE'],
            ruleMatches: [],
          }
        : {
            strength: evaluation.evidenceStrength,
            readiness: evaluation.readiness,
            blockers: evaluation.blockers,
            ruleMatches: evaluation.ruleMatches,
          },
      ...(costs[0] !== undefined ? { cost: costs[0] } : {}),
    };
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
      ...(input.cloudResourceId !== undefined ? { cloudResourceId: input.cloudResourceId } : {}),
      ...(input.metricNames !== undefined ? { metricNames: input.metricNames } : {}),
      limit: maxOverviewSamples,
    });
    const resources = await this.repository.listResourcesForTenant(tenantId, 200);
    const resourceIds = unique(samples.map((sample) => sample.externalResourceId));
    const cloudResourceIds = unique(samples.map((sample) => sample.cloudResourceId).filter((value): value is string => value !== undefined));
    const costContext = await this.repository.listCostContextForResources(tenantId, resourceIds, cloudResourceIds);

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
      ...(input.cloudResourceId !== undefined ? { cloudResourceId: input.cloudResourceId } : {}),
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
        ...(input.cloudResourceId !== undefined ? { cloudResourceId: input.cloudResourceId } : {}),
      });

      return buildCoverageFromAggregate(aggregate, input.startDate, input.endDate);
    }

    const samples = await this.repository.listMetricCoverageSamplesForTenant(tenantId, {
      ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
      ...(input.externalResourceId !== undefined ? { externalResourceId: input.externalResourceId } : {}),
      ...(input.cloudResourceId !== undefined ? { cloudResourceId: input.cloudResourceId } : {}),
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
