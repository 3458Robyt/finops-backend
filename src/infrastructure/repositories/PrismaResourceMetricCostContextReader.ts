import type { TechnicalCostContextItem } from '../../domain/interfaces/IResourceMetricRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { CurrencyConverter, normalizeCurrencyCode } from '../finance/CurrencyConverter.js';

/** Reads tenant-scoped billing context for exact technical resource IDs. */
export class PrismaResourceMetricCostContextReader {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly currencyConverter?: CurrencyConverter,
  ) {}

  public async listForResources(
    tenantId: string,
    externalResourceIds: readonly string[],
    cloudResourceIds?: readonly string[],
    period?: Readonly<{ readonly start: Date; readonly end: Date }>,
  ): Promise<readonly TechnicalCostContextItem[]> {
    const normalizedResourceIds = [...new Set(externalResourceIds.map((value) => value.trim()).filter((value) => value !== ''))];
    const normalizedCloudResourceIds = [...new Set((cloudResourceIds ?? []).map((value) => value.trim()).filter((value) => value !== ''))];
    if (normalizedResourceIds.length === 0 && normalizedCloudResourceIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.$queryRaw<Array<{
      readonly external_resource_id: string;
      readonly cloud_resource_id: string | null;
      readonly cloud_connection_id: string | null;
      readonly total_cost: number;
      readonly currency: string;
      readonly metric_count: number;
      readonly period: Date;
    }>>(Prisma.sql`
      SELECT
        COALESCE(cr.external_resource_id, btrim(cm.resource_id)) AS external_resource_id,
        cm.cloud_resource_id,
        cm.cloud_connection_id,
        date_trunc('day', cm.charge_period_start)::timestamptz AS period,
        sum(cm.billed_cost)::float8 AS total_cost,
        cm.billing_currency AS currency,
        count(*)::int AS metric_count
      FROM cost_metrics cm
      LEFT JOIN cloud_resources cr
        ON cr.id = cm.cloud_resource_id
       AND cr.tenant_id = cm.tenant_id
      WHERE cm.tenant_id = ${tenantId}
        ${period === undefined ? Prisma.empty : Prisma.sql`AND cm.charge_period_start >= ${period.start} AND cm.charge_period_start < ${period.end}`}
        AND (
          (${normalizedCloudResourceIds.length > 0 ? Prisma.sql`cm.cloud_resource_id IN (${Prisma.join(normalizedCloudResourceIds)})` : Prisma.sql`FALSE`})
          OR (
          (
            cm.cloud_resource_id IS NOT NULL
            AND ${normalizedResourceIds.length > 0 ? Prisma.sql`cr.external_resource_id IN (${Prisma.join(normalizedResourceIds)})` : Prisma.sql`FALSE`}
          )
          OR (
            cm.cloud_resource_id IS NULL
            AND ${normalizedResourceIds.length > 0 ? Prisma.sql`btrim(cm.resource_id) IN (${Prisma.join(normalizedResourceIds)})` : Prisma.sql`FALSE`}
            AND NOT EXISTS (
              SELECT 1
              FROM cloud_resources exact_resource
              WHERE exact_resource.tenant_id = cm.tenant_id
                AND exact_resource.cloud_connection_id = cm.cloud_connection_id
                AND btrim(exact_resource.external_resource_id) = btrim(cm.resource_id)
            )
          )
          )
        )
      GROUP BY COALESCE(cr.external_resource_id, btrim(cm.resource_id)), cm.cloud_resource_id, cm.cloud_connection_id, date_trunc('day', cm.charge_period_start), cm.billing_currency
    `);
    const reportingCurrency = this.currencyConverter === undefined
      ? undefined
      : normalizeCurrencyCode((await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { reportingCurrency: true } }))?.reportingCurrency ?? 'USD');
    const projections = this.currencyConverter === undefined || reportingCurrency === undefined
      ? rows.map((row) => ({ amount: Number(row.total_cost), currency: row.currency, status: 'NOT_REQUIRED' as const }))
      : await this.currencyConverter.convertMany(
        rows.map((row) => ({ amount: Number(row.total_cost), currency: row.currency, at: row.period })),
        reportingCurrency,
      );
    const grouped = new Map<string, TechnicalCostContextItem>();
    rows.forEach((row, index) => {
      const projection = projections[index]!;
      const currency = projection.amount === null ? row.currency : reportingCurrency ?? row.currency;
      const key = `${row.external_resource_id}:${row.cloud_resource_id ?? ''}:${row.cloud_connection_id ?? ''}:${currency}`;
      const current = grouped.get(key);
      const nativeTotals = addNativeTotal(current?.nativeTotals ?? [], row.currency, Number(row.total_cost));
      if (current === undefined) {
        grouped.set(key, {
          externalResourceId: row.external_resource_id,
          ...(row.cloud_resource_id !== null ? { cloudResourceId: row.cloud_resource_id } : {}),
          ...(row.cloud_connection_id !== null ? { cloudConnectionId: row.cloud_connection_id } : {}),
          totalCost: projection.amount ?? 0,
          currency,
          metricCount: row.metric_count,
          nativeTotals,
          conversionStatus: projection.status,
        });
        return;
      }
      grouped.set(key, {
        ...current,
        totalCost: current.totalCost + (projection.amount ?? 0),
        metricCount: current.metricCount + row.metric_count,
        nativeTotals,
        conversionStatus: mergeStatus(current.conversionStatus, projection.status),
      });
    });
    return [...grouped.values()];
  }
}

function addNativeTotal(
  totals: readonly { readonly currency: string; readonly amount: number }[],
  currency: string,
  amount: number,
): readonly { readonly currency: string; readonly amount: number }[] {
  const next = new Map(totals.map((item) => [item.currency, item.amount]));
  next.set(currency, (next.get(currency) ?? 0) + amount);
  return [...next.entries()].map(([itemCurrency, itemAmount]) => ({ currency: itemCurrency, amount: itemAmount }));
}

function mergeStatus(
  left: TechnicalCostContextItem['conversionStatus'] | undefined,
  right: NonNullable<TechnicalCostContextItem['conversionStatus']>,
): NonNullable<TechnicalCostContextItem['conversionStatus']> {
  if (left === 'MISSING_RATE' || right === 'MISSING_RATE') return 'MISSING_RATE';
  if (left === 'UNSUPPORTED_CURRENCY' || right === 'UNSUPPORTED_CURRENCY') return 'UNSUPPORTED_CURRENCY';
  if (left === 'CONVERTED' || right === 'CONVERTED') return 'CONVERTED';
  return 'NOT_REQUIRED';
}
