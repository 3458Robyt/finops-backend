import 'dotenv/config';
import { Prisma } from '../src/generated/prisma/client.js';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { runWithDatabaseContext } from '../src/infrastructure/database/tenantContext.js';

interface AuditArguments {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly start: Date;
  readonly end: Date;
  readonly json: boolean;
}

/**
 * Produces a bounded, read-only audit of one connection and time range.
 *
 * It is intentionally independent from ingestion jobs: an audit must expose
 * missing data instead of creating synthetic jobs or changing coverage.
 */
async function main(): Promise<void> {
  const args = readArguments();
  const prisma = getPrismaClient();
  try {
    const report = await runWithDatabaseContext(
      { tenantId: args.tenantId, role: 'MASTER_ADMIN', workerId: 'maintenance:ingestion-audit' },
      () => buildReport(prisma, args),
    );
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printReport(report);
  } finally {
    await prisma.$disconnect();
  }
}

async function buildReport(
  prisma: ReturnType<typeof getPrismaClient>,
  args: AuditArguments,
): Promise<Readonly<Record<string, unknown>>> {
  const [connection, raw, daily, coverage, focus, costs, resources, jobs] = await Promise.all([
    prisma.$queryRaw<readonly {
      readonly id: string;
      readonly name: string;
      readonly provider_code: string;
      readonly status: string;
      readonly default_region: string | null;
      readonly last_validated_at: Date | null;
      readonly authentication_status: string | null;
    }[]>(Prisma.sql`
      SELECT id, name, provider_code, status, default_region, last_validated_at,
        metadata->'capabilityValidation'->'authentication'->>'status' AS authentication_status
      FROM cloud_connections
      WHERE tenant_id = ${args.tenantId} AND id = ${args.connectionId}
      LIMIT 1
    `),
    prisma.$queryRaw<readonly {
      readonly sample_count: bigint;
      readonly stream_count: bigint;
      readonly resource_count: bigint;
      readonly metric_count: bigint;
      readonly statistic_count: bigint;
      readonly linked_count: bigint;
      readonly unresolved_count: bigint;
      readonly first_sampled_at: Date | null;
      readonly last_sampled_at: Date | null;
    }[]>(Prisma.sql`
      SELECT
        COUNT(*)::bigint AS sample_count,
        COUNT(DISTINCT (provider_namespace, region_id, external_resource_id, metric_name,
          statistic, granularity_seconds, dimensions_hash))::bigint AS stream_count,
        COUNT(DISTINCT external_resource_id)::bigint AS resource_count,
        COUNT(DISTINCT metric_name)::bigint AS metric_count,
        COUNT(DISTINCT statistic)::bigint AS statistic_count,
        COUNT(*) FILTER (WHERE cloud_resource_id IS NOT NULL)::bigint AS linked_count,
        COUNT(*) FILTER (WHERE cloud_resource_id IS NULL)::bigint AS unresolved_count,
        MIN(sampled_at) AS first_sampled_at,
        MAX(sampled_at) AS last_sampled_at
      FROM resource_metric_samples
      WHERE tenant_id = ${args.tenantId}
        AND cloud_connection_id = ${args.connectionId}
        AND source_type = 'TECHNICAL_METRIC'::"IngestionSourceType"
        AND sampled_at >= ${args.start}
        AND sampled_at < ${args.end}
    `),
    prisma.$queryRaw<readonly {
      readonly day: Date;
      readonly sample_count: bigint;
      readonly stream_count: bigint;
    }[]>(Prisma.sql`
      SELECT date_trunc('day', sampled_at) AS day,
        COUNT(*)::bigint AS sample_count,
        COUNT(DISTINCT (provider_namespace, region_id, external_resource_id, metric_name,
          statistic, granularity_seconds, dimensions_hash))::bigint AS stream_count
      FROM resource_metric_samples
      WHERE tenant_id = ${args.tenantId}
        AND cloud_connection_id = ${args.connectionId}
        AND source_type = 'TECHNICAL_METRIC'::"IngestionSourceType"
        AND sampled_at >= ${args.start}
        AND sampled_at < ${args.end}
      GROUP BY 1
      ORDER BY 1
    `),
    prisma.$queryRaw<readonly {
      readonly status: string;
      readonly windows: bigint;
      readonly expected_samples: bigint;
      readonly observed_samples: bigint;
      readonly missing_samples: bigint;
    }[]>(Prisma.sql`
      SELECT status::text,
        COUNT(*)::bigint AS windows,
        COALESCE(SUM(expected_samples), 0)::bigint AS expected_samples,
        COALESCE(SUM(observed_samples), 0)::bigint AS observed_samples,
        COALESCE(SUM(missing_samples), 0)::bigint AS missing_samples
      FROM resource_metric_coverage_windows
      WHERE tenant_id = ${args.tenantId}
        AND cloud_connection_id = ${args.connectionId}
        AND window_start < ${args.end}
        AND window_end > ${args.start}
      GROUP BY status
      ORDER BY status
    `),
    prisma.$queryRaw<readonly {
      readonly row_count: bigint;
      readonly resource_count: bigint;
      readonly service_count: bigint;
      readonly currency_count: bigint;
      readonly billed_cost: number | null;
      readonly first_charge_period: Date | null;
      readonly last_charge_period: Date | null;
    }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS row_count,
        COUNT(DISTINCT resource_id)::bigint AS resource_count,
        COUNT(DISTINCT service_name)::bigint AS service_count,
        COUNT(DISTINCT billing_currency)::bigint AS currency_count,
        COALESCE(SUM(billed_cost), 0)::float8 AS billed_cost,
        MIN(charge_period_start) AS first_charge_period,
        MAX(charge_period_end) AS last_charge_period
      FROM focus_cost_line_items
      WHERE tenant_id = ${args.tenantId}
        AND cloud_connection_id = ${args.connectionId}
        AND charge_period_start < ${args.end}
        AND charge_period_end > ${args.start}
    `),
    prisma.$queryRaw<readonly {
      readonly row_count: bigint;
      readonly resource_count: bigint;
      readonly linked_count: bigint;
      readonly unresolved_count: bigint;
      readonly first_charge_period: Date | null;
      readonly last_charge_period: Date | null;
    }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS row_count,
        COUNT(DISTINCT resource_id)::bigint AS resource_count,
        COUNT(*) FILTER (WHERE cloud_resource_id IS NOT NULL)::bigint AS linked_count,
        COUNT(*) FILTER (WHERE cloud_resource_id IS NULL)::bigint AS unresolved_count,
        MIN(charge_period_start) AS first_charge_period,
        MAX(charge_period_end) AS last_charge_period
      FROM cost_metrics
      WHERE tenant_id = ${args.tenantId}
        AND cloud_connection_id = ${args.connectionId}
        AND charge_period_start < ${args.end}
        AND charge_period_end > ${args.start}
    `),
    prisma.$queryRaw<readonly {
      readonly resource_count: bigint;
      readonly active_count: bigint;
      readonly named_count: bigint;
      readonly first_seen_at: Date | null;
      readonly last_seen_at: Date | null;
    }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS resource_count,
        COUNT(*) FILTER (WHERE status = 'ACTIVE'::"CloudResourceStatus")::bigint AS active_count,
        COUNT(*) FILTER (WHERE name IS NOT NULL AND btrim(name) <> '')::bigint AS named_count,
        MIN(first_seen_at) AS first_seen_at,
        MAX(last_seen_at) AS last_seen_at
      FROM cloud_resources
      WHERE tenant_id = ${args.tenantId} AND cloud_connection_id = ${args.connectionId}
    `),
    prisma.$queryRaw<readonly {
      readonly source_type: string;
      readonly status: string;
      readonly data_outcome: string | null;
      readonly jobs: bigint;
      readonly first_target_start: Date | null;
      readonly last_target_end: Date | null;
    }[]>(Prisma.sql`
      SELECT source_type::text, status::text, data_outcome::text,
        COUNT(*)::bigint AS jobs,
        MIN(target_start) AS first_target_start,
        MAX(target_end) AS last_target_end
      FROM ingestion_jobs
      WHERE tenant_id = ${args.tenantId}
        AND cloud_connection_id = ${args.connectionId}
        AND target_start < ${args.end}
        AND target_end > ${args.start}
      GROUP BY source_type, status, data_outcome
      ORDER BY source_type, status, data_outcome
    `),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    range: { start: args.start.toISOString(), end: args.end.toISOString() },
    connection: connection[0] === undefined ? null : {
      id: connection[0].id,
      name: connection[0].name,
      provider: connection[0].provider_code,
      status: connection[0].status,
      defaultRegion: connection[0].default_region,
      lastValidatedAt: connection[0].last_validated_at?.toISOString() ?? null,
      authenticationStatus: connection[0].authentication_status,
    },
    technicalMetrics: {
      totals: normalizeRow(raw[0]),
      daily: daily.map((row) => ({
        day: row.day.toISOString(),
        sampleCount: toNumber(row.sample_count),
        streamCount: toNumber(row.stream_count),
      })),
      coverage: coverage.map((row) => ({
        status: row.status,
        windows: toNumber(row.windows),
        expectedSamples: toNumber(row.expected_samples),
        observedSamples: toNumber(row.observed_samples),
        missingSamples: toNumber(row.missing_samples),
      })),
    },
    focus: normalizeRow(focus[0]),
    costMetrics: normalizeRow(costs[0]),
    inventory: normalizeRow(resources[0]),
    jobs: jobs.map((row) => ({
      sourceType: row.source_type,
      status: row.status,
      dataOutcome: row.data_outcome,
      jobs: toNumber(row.jobs),
      firstTargetStart: row.first_target_start?.toISOString() ?? null,
      lastTargetEnd: row.last_target_end?.toISOString() ?? null,
    })),
  };
}

function normalizeRow(row: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> {
  if (row === undefined) return {};
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    camelCase(key),
    value instanceof Date ? value.toISOString() : typeof value === 'bigint' ? Number(value) : value,
  ]));
}

function printReport(report: Readonly<Record<string, unknown>>): void {
  const connection = report.connection as Readonly<Record<string, unknown>> | null;
  const metrics = report.technicalMetrics as Readonly<Record<string, unknown>>;
  const totals = metrics.totals as Readonly<Record<string, unknown>>;
  console.log('=== Auditoría de ingesta ===');
  console.log(`Conexión: ${connection?.['name'] ?? 'no encontrada'} (${connection?.['id'] ?? 'n/a'})`);
  console.log(`Rango: ${JSON.stringify(report.range)}`);
  console.log(`Validación: ${connection?.['authenticationStatus'] ?? 'n/a'} · última: ${connection?.['lastValidatedAt'] ?? 'n/a'}`);
  console.log(`Muestras: ${totals['sampleCount'] ?? 0} · streams: ${totals['streamCount'] ?? 0} · recursos: ${totals['resourceCount'] ?? 0}`);
  console.log(`Vínculo técnico: ${totals['linkedCount'] ?? 0} enlazadas · ${totals['unresolvedCount'] ?? 0} sin resolver`);
  console.log('Cobertura:');
  for (const row of metrics.coverage as readonly Readonly<Record<string, unknown>>[]) {
    console.log(`  ${row['status']}: ${row['windows']} ventanas · ${row['observedSamples']}/${row['expectedSamples']} muestras · faltan ${row['missingSamples']}`);
  }
  console.log(`FOCUS: ${JSON.stringify(report.focus)}`);
  console.log(`Cost metrics: ${JSON.stringify(report.costMetrics)}`);
  console.log(`Inventario: ${JSON.stringify(report.inventory)}`);
  console.log('Jobs:');
  for (const row of report.jobs as readonly Readonly<Record<string, unknown>>[]) console.log(`  ${JSON.stringify(row)}`);
}

function readArguments(): AuditArguments {
  const tenantId = readRequired('--tenant-id');
  const connectionId = readRequired('--connection-id');
  const start = parseDate(readRequired('--start'), '--start');
  const end = parseDate(readRequired('--end'), '--end');
  if (end <= start) throw new Error('--end debe ser posterior a --start.');
  if (end.getTime() - start.getTime() > 91 * 24 * 60 * 60 * 1000) {
    throw new Error('El rango de auditoría no puede superar 91 días.');
  }
  return { tenantId, connectionId, start, end, json: process.argv.includes('--json') };
}

function readRequired(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined || value.startsWith('--')) throw new Error(`Pass ${name} <value>.`);
  return value;
}

function parseDate(value: string, name: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} debe ser una fecha ISO válida.`);
  return date;
}

function toNumber(value: bigint | number | null | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  return value ?? 0;
}

function camelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
