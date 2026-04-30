import { createHash } from 'node:crypto';
import type {
  CostMetricBatchContext,
  CostMetricQuery,
  ICostRepository,
} from '../../domain/interfaces/ICostRepository.js';
import type { InternalCostMetric } from '../../domain/models/InternalCostMetric.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { CloudProvider } from '../../generated/prisma/client.js';

export class PrismaCostRepository implements ICostRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async insertBatch(
    context: CostMetricBatchContext,
    metrics: readonly InternalCostMetric[],
  ): Promise<number> {
    if (metrics.length === 0) {
      return 0;
    }

    const provider = this.toCloudProvider(context.providerName);

    const result = await this.prisma.costMetric.createMany({
      data: metrics.map((metric) => {
        const chargePeriodStart = metric.timestamp;
        const chargePeriodEnd = this.addDays(chargePeriodStart, 1);

        const billingAccountId = this.getTag(metric, 'accountId') ?? this.getTag(metric, 'tenantId') ?? null;
        const subAccountId = this.getTag(metric, 'accountId') ?? this.getTag(metric, 'compartmentId') ?? null;

        return {
          tenantId: context.tenantId,
          cloudAccountId: context.cloudAccountId,
          ...(context.ingestionRunId !== undefined ? { ingestionRunId: context.ingestionRunId } : {}),
          provider,
          billingAccountId,
          subAccountId,
          serviceName: metric.service,
          resourceId: metric.resourceId,
          chargePeriodStart,
          chargePeriodEnd,
          billedCost: metric.amount,
          effectiveCost: metric.amount,
          billingCurrency: metric.currency,
          pricingCurrency: metric.currency,
          ...(metric.usage !== undefined ? { consumedQuantity: metric.usage } : {}),
          ...(metric.usageUnit !== undefined ? { consumedUnit: metric.usageUnit } : {}),
          metricIdentityHash: this.buildMetricIdentityHash(context, metric),
          tags: metric.tags,
        };
      }),
      skipDuplicates: true,
    });

    return result.count;
  }

  public async findByDateRange(query: CostMetricQuery): Promise<InternalCostMetric[]> {
    const rows = await this.prisma.costMetric.findMany({
      where: {
        tenantId: query.tenantId,
        chargePeriodStart: {
          gte: query.startDate,
          lt: query.endDate,
        },
        ...(query.providerName !== undefined ? { provider: this.toCloudProvider(query.providerName) } : {}),
        ...(query.cloudAccountId !== undefined ? { cloudAccountId: query.cloudAccountId } : {}),
      },
      orderBy: [
        { chargePeriodStart: 'asc' },
        { serviceName: 'asc' },
      ],
    });

    return rows.map((row) => ({
      resourceId: row.resourceId,
      service: row.serviceName,
      amount: Number(row.billedCost),
      currency: row.billingCurrency,
      ...(row.consumedQuantity !== null ? { usage: Number(row.consumedQuantity) } : {}),
      ...(row.consumedUnit !== null ? { usageUnit: row.consumedUnit } : {}),
      timestamp: row.chargePeriodStart,
      tags: this.toStringRecord(row.tags),
    }));
  }

  private toCloudProvider(providerName: string): CloudProvider {
    const normalized = providerName.trim().toUpperCase();

    if (normalized === CloudProvider.AWS || normalized === CloudProvider.OCI) {
      return normalized;
    }

    throw new Error(`Unsupported cloud provider for persistence: ${providerName}`);
  }

  private buildMetricIdentityHash(
    context: CostMetricBatchContext,
    metric: InternalCostMetric,
  ): string {
    const identity = [
      context.tenantId,
      context.cloudAccountId,
      context.providerName,
      metric.timestamp.toISOString(),
      metric.service,
      metric.resourceId,
      metric.currency,
    ];

    return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  }

  private getTag(metric: InternalCostMetric, key: string): string | undefined {
    return metric.tags[key];
  }

  private toStringRecord(value: unknown): Readonly<Record<string, string>> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    const output: Record<string, string> = {};

    for (const [key, raw] of Object.entries(value)) {
      if (typeof raw === 'string') {
        output[key] = raw;
      }
    }

    return output;
  }

  private addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
  }
}
