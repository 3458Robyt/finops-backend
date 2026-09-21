import 'dotenv/config';

import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { runWithDatabaseContext } from '../src/infrastructure/database/tenantContext.js';
import {
  normalizeExternalResourceId,
  resourceExternalIdAliases,
  resolveExactResourceLink,
  resourceLookupKey,
  type ResourceLinkReasonCode,
} from '../src/domain/models/ResourceLinkage.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { backfillHistoricalOciResources } from '../src/infrastructure/ingestion/PrismaHistoricalOciResourceBackfill.js';
import { isOciAggregateResourceId } from '../src/infrastructure/ingestion/oci/OciHistoricalResourceCatalog.js';

const defaultBatchSize = 500;
const reasonCodes: readonly ResourceLinkReasonCode[] = [
  'EMPTY_RESOURCE_ID',
  'INVENTORY_RESOURCE_NOT_FOUND',
  'CONNECTION_NOT_AVAILABLE',
  'AMBIGUOUS_RESOURCE_ID',
  'SERVICE_LEVEL_COST',
  'INVALID_EXISTING_REFERENCE',
  'UNSUPPORTED_RESOURCE_ID',
];

interface LinkCounters {
  examined: number;
  linked: number;
  alreadyLinked: number;
  updated: number;
  notEligible: number;
  unresolved: number;
  ambiguous: number;
  failed: number;
  reasons: Record<ResourceLinkReasonCode, number>;
  failureMessages: string[];
}

interface LinkAction {
  readonly id?: string;
  readonly chargePeriodStart?: Date;
  readonly metricIdentityHash?: string;
  readonly cloudResourceId?: string;
  readonly reason?: ResourceLinkReasonCode;
  readonly currentCloudResourceId?: string | null;
  readonly currentReason?: string | null;
}

interface ResourceRow {
  readonly id: string;
  readonly cloudConnectionId: string;
  readonly externalResourceId: string;
  readonly tenantId: string;
  readonly rawResource: unknown;
}

interface CostMetricRow {
  readonly charge_period_start: Date;
  readonly metric_identity_hash: string;
  readonly cloud_connection_id: string | null;
  readonly resource_id: string;
  readonly cloud_resource_id: string | null;
  readonly resource_link_reason: string | null;
  readonly provider_raw: unknown;
}

interface RecommendationRow {
  readonly id: string;
  readonly type: string;
  readonly cloudResourceId: string | null;
  readonly resourceLinkReason: string | null;
  readonly evidence: unknown;
}

interface ResourceCatalog {
  readonly index: ReadonlyMap<string, readonly string[]>;
  readonly byId: ReadonlyMap<string, ResourceRow>;
}

function createCounters(): LinkCounters {
  return {
    examined: 0,
    linked: 0,
    alreadyLinked: 0,
    updated: 0,
    notEligible: 0,
    unresolved: 0,
    ambiguous: 0,
    failed: 0,
    reasons: Object.fromEntries(reasonCodes.map((code) => [code, 0])) as Record<ResourceLinkReasonCode, number>,
    failureMessages: [],
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
    || process.env['RESOURCE_LINK_RECONCILE_APPLY'] === 'true'
    || process.env['npm_config_apply'] === 'true';
  const batchSize = parseBatchSize();
  const tenantFilter = readArgument('--tenant=');
  const only = readOnlyTable();
  assertSafeScope(tenantFilter);
  const prisma = getPrismaClient();

  try {
    const tenants = await runWithDatabaseContext(
      { userId: 'resource-linkage-reconciler', role: 'MASTER_ADMIN' },
      () => prisma.tenant.findMany({
        where: tenantFilter === undefined ? undefined : { id: tenantFilter },
        orderBy: { id: 'asc' },
        select: { id: true },
      }),
    );

    const results = [];
    for (const tenant of tenants) {
      const result = await runWithDatabaseContext(
        { tenantId: tenant.id, userId: 'resource-linkage-reconciler', role: 'MASTER_ADMIN' },
        () => reconcileTenant(prisma, tenant.id, batchSize, apply, only),
      );
      results.push(result);
    }

    console.log(JSON.stringify({
      success: true,
      mode: apply ? 'APPLY' : 'DRY_RUN',
      batchSize,
      only,
      tenants: results,
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

async function reconcileTenant(
  prisma: PrismaClient,
  tenantId: string,
  batchSize: number,
  apply: boolean,
  only: 'all' | 'cost_metrics' | 'resource_metric_samples' | 'recommendations',
): Promise<Record<string, unknown>> {
  const historicalOciResources = await backfillHistoricalOciResources(prisma, tenantId, batchSize, apply);
  const resources = await loadResourceCatalog(prisma, tenantId);
  const costMetrics = only === 'all' || only === 'cost_metrics'
    ? await safelyReconcile('cost_metrics', () => reconcileCostMetrics(prisma, tenantId, batchSize, apply, resources))
    : createCounters();
  const metricSamples = only === 'all' || only === 'resource_metric_samples'
    ? await safelyReconcile('resource_metric_samples', () => reconcileMetricSamples(prisma, tenantId, batchSize, apply, resources))
    : createCounters();
  const recommendations = only === 'all' || only === 'recommendations'
    ? await safelyReconcile('recommendations', () => reconcileRecommendations(prisma, tenantId, batchSize, apply, resources))
    : createCounters();
  const summary = { historicalOciResources, costMetrics, metricSamples, recommendations };

  if (apply) {
    const tables = [costMetrics, metricSamples, recommendations];
    const hasFailure = tables.some((table) => table.failed > 0);
    const hasUnresolved = tables.some((table) => table.unresolved > 0);
    await prisma.dataQualityCheck.create({
      data: {
        tenantId,
        sourceType: 'INVENTORY',
        checkName: 'resource_linkage_reconciliation',
        status: hasFailure ? 'FAILED' : hasUnresolved ? 'WARNING' : 'PASSED',
        details: {
          mode: 'APPLY',
          batchSize,
          ...summary,
        } as Prisma.InputJsonValue,
      },
    });
  }

  return { tenantId, ...summary };
}

async function safelyReconcile(
  table: string,
  operation: () => Promise<LinkCounters>,
): Promise<LinkCounters> {
  try {
    return await operation();
  } catch (error: unknown) {
    const counters = createCounters();
    counters.failed = 1;
    counters.failureMessages.push(`${table}: ${error instanceof Error ? error.message : String(error)}`);
    return counters;
  }
}

async function reconcileCostMetrics(
  prisma: PrismaClient,
  tenantId: string,
  batchSize: number,
  apply: boolean,
  resources: ResourceCatalog,
): Promise<LinkCounters> {
  const counters = createCounters();
  let cursor: { readonly start: Date; readonly hash: string } | undefined;

  while (true) {
    const rows = await prisma.$queryRaw<CostMetricRow[]>(Prisma.sql`
      SELECT
        charge_period_start,
        metric_identity_hash,
        cloud_connection_id,
        resource_id,
        cloud_resource_id,
        resource_link_reason,
        provider_raw
      FROM cost_metrics
      WHERE tenant_id = ${tenantId}
        ${cursor === undefined
          ? Prisma.empty
          : Prisma.sql`AND (charge_period_start, metric_identity_hash) > (${cursor.start}, ${cursor.hash})`}
      ORDER BY charge_period_start ASC, metric_identity_hash ASC
      LIMIT ${batchSize}
    `);
    if (rows.length === 0) break;

    const actions = rows.map((row) => ({
      chargePeriodStart: row.charge_period_start,
      metricIdentityHash: row.metric_identity_hash,
      ...resolveAction({
        cloudConnectionId: row.cloud_connection_id,
        externalResourceId: row.resource_id,
        currentCloudResourceId: row.cloud_resource_id,
        currentReason: row.resource_link_reason,
        existingResource: resources.byId.get(row.cloud_resource_id ?? ''),
        resourceIndex: resources.index,
        serviceLevel: isServiceLevelCost(row.resource_id, row.provider_raw),
      }),
    }));

    recordActions(counters, actions);
    if (apply) await applyCostActions(prisma, tenantId, actions);
    cursor = { start: rows.at(-1)!.charge_period_start, hash: rows.at(-1)!.metric_identity_hash };
    if (rows.length < batchSize) break;
  }

  return counters;
}

async function reconcileMetricSamples(
  prisma: PrismaClient,
  tenantId: string,
  batchSize: number,
  apply: boolean,
  resources: ResourceCatalog,
): Promise<LinkCounters> {
  const counters = createCounters();
  let cursor: string | undefined;

  while (true) {
    const rows = await prisma.resourceMetricSample.findMany({
      where: { tenantId },
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      orderBy: { id: 'asc' },
      take: batchSize,
      select: {
        id: true,
        cloudConnectionId: true,
        externalResourceId: true,
        cloudResourceId: true,
        resourceLinkReason: true,
      },
    });
    if (rows.length === 0) break;

    const actions = rows.map((row) => ({
      id: row.id,
      ...resolveAction({
        cloudConnectionId: row.cloudConnectionId,
        externalResourceId: row.externalResourceId,
        currentCloudResourceId: row.cloudResourceId,
        currentReason: row.resourceLinkReason,
        existingResource: resources.byId.get(row.cloudResourceId ?? ''),
        resourceIndex: resources.index,
      }),
    }));

    recordActions(counters, actions);
    if (apply) await applyMetricSampleActions(prisma, tenantId, actions);
    cursor = rows.at(-1)!.id;
    if (rows.length < batchSize) break;
  }

  return counters;
}

async function reconcileRecommendations(
  prisma: PrismaClient,
  tenantId: string,
  batchSize: number,
  apply: boolean,
  resources: ResourceCatalog,
): Promise<LinkCounters> {
  const counters = createCounters();
  let cursor: string | undefined;

  while (true) {
    const rows = await prisma.recommendation.findMany({
      where: { tenantId },
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      orderBy: { id: 'asc' },
      take: batchSize,
      select: {
        id: true,
        type: true,
        cloudResourceId: true,
        resourceLinkReason: true,
        evidence: true,
      },
    });
    if (rows.length === 0) break;

    const actions = rows.map((row) => ({
      id: row.id,
      ...resolveRecommendationAction(row, resources.byId),
    }));

    recordActions(counters, actions);
    if (apply) await applyRecommendationActions(prisma, tenantId, actions);
    cursor = rows.at(-1)!.id;
    if (rows.length < batchSize) break;
  }

  return counters;
}

function resolveRecommendationAction(
  row: RecommendationRow,
  resourcesById: ReadonlyMap<string, ResourceRow>,
): Pick<LinkAction, 'cloudResourceId' | 'reason' | 'currentCloudResourceId' | 'currentReason'> {
  if (row.cloudResourceId !== null) {
    return resourcesById.has(row.cloudResourceId)
      ? { cloudResourceId: row.cloudResourceId, currentCloudResourceId: row.cloudResourceId, currentReason: row.resourceLinkReason }
      : { reason: 'INVALID_EXISTING_REFERENCE', currentCloudResourceId: row.cloudResourceId, currentReason: row.resourceLinkReason };
  }

  const evidenceResourceId = readString(row.evidence, 'cloudResourceId');
  if (evidenceResourceId !== undefined) {
    return resourcesById.has(evidenceResourceId)
      ? { cloudResourceId: evidenceResourceId, currentCloudResourceId: null, currentReason: row.resourceLinkReason }
      : { reason: 'INVALID_EXISTING_REFERENCE', currentCloudResourceId: null, currentReason: row.resourceLinkReason };
  }

  const externalResourceId = readString(row.evidence, 'externalResourceId')
    ?? readString(row.evidence, 'resourceId');
  return {
    reason: externalResourceId === undefined
      ? isServiceRecommendation(row.type) ? 'SERVICE_LEVEL_COST' : 'EMPTY_RESOURCE_ID'
      : 'CONNECTION_NOT_AVAILABLE',
    currentCloudResourceId: null,
    currentReason: row.resourceLinkReason,
  };
}

function resolveAction(input: {
  readonly cloudConnectionId: string | null;
  readonly externalResourceId: unknown;
  readonly currentCloudResourceId: string | null;
  readonly currentReason: string | null;
  readonly existingResource?: ResourceRow;
  readonly resourceIndex: ReadonlyMap<string, readonly string[]>;
  readonly serviceLevel?: boolean;
}): Pick<LinkAction, 'cloudResourceId' | 'reason' | 'currentCloudResourceId' | 'currentReason'> {
  if (input.currentCloudResourceId !== null) {
    const existing = input.existingResource;
    const normalizedExternalId = normalizeExternalResourceId(input.externalResourceId);
    const isValid = existing !== undefined
      && input.cloudConnectionId !== null
      && existing.cloudConnectionId === input.cloudConnectionId
      && normalizedExternalId !== undefined
      && resourceExternalIdAliases(
        existing.rawResource as Readonly<Record<string, unknown>> | null,
        existing.externalResourceId,
      ).includes(normalizedExternalId);
    return isValid
      ? { cloudResourceId: input.currentCloudResourceId, currentCloudResourceId: input.currentCloudResourceId, currentReason: input.currentReason }
      : { reason: 'INVALID_EXISTING_REFERENCE', currentCloudResourceId: input.currentCloudResourceId, currentReason: input.currentReason };
  }

  const resolution = resolveExactResourceLink({
    cloudConnectionId: input.cloudConnectionId ?? undefined,
    externalResourceId: input.externalResourceId,
    resourceIdsByKey: input.resourceIndex,
    ...(input.serviceLevel === true ? { serviceLevel: true } : {}),
  });
  return {
    ...(resolution.cloudResourceId !== undefined ? { cloudResourceId: resolution.cloudResourceId } : {}),
    ...(resolution.reason !== undefined ? { reason: resolution.reason } : {}),
    currentCloudResourceId: null,
    currentReason: input.currentReason,
  };
}

async function loadResourceCatalog(
  prisma: PrismaClient,
  tenantId: string,
): Promise<ResourceCatalog> {
  const resources = await prisma.cloudResource.findMany({
    where: { tenantId },
    select: { id: true, tenantId: true, cloudConnectionId: true, externalResourceId: true, rawResource: true },
  });
  const index = new Map<string, string[]>();
  for (const resource of resources) {
    for (const externalResourceId of resourceExternalIdAliases(
      resource.rawResource as Readonly<Record<string, unknown>> | null,
      resource.externalResourceId,
    )) {
      const key = resourceLookupKey(resource.cloudConnectionId, externalResourceId);
      const matches = index.get(key) ?? [];
      if (!matches.includes(resource.id)) index.set(key, [...matches, resource.id]);
    }
  }
  return { index, byId: new Map(resources.map((resource) => [resource.id, resource])) };
}

function recordActions(counters: LinkCounters, actions: readonly LinkAction[]): void {
  for (const action of actions) {
    counters.examined += 1;
    const sameLink = action.cloudResourceId !== undefined
      && action.cloudResourceId === action.currentCloudResourceId
      && action.reason === undefined
      && action.currentReason === null;
    if (action.cloudResourceId !== undefined) {
      counters.linked += 1;
      if (sameLink) counters.alreadyLinked += 1;
      else counters.updated += 1;
      continue;
    }

    if (action.reason !== undefined) {
      counters.reasons[action.reason] += 1;
      if (action.reason === 'SERVICE_LEVEL_COST' || action.reason === 'EMPTY_RESOURCE_ID') {
        counters.notEligible += 1;
      } else {
        counters.unresolved += 1;
      }
      if (action.reason === 'AMBIGUOUS_RESOURCE_ID') {
        counters.ambiguous += 1;
      }
    } else {
      counters.unresolved += 1;
    }
    if (action.currentCloudResourceId !== null || action.currentReason !== action.reason) {
      counters.updated += 1;
    }
  }
}

async function applyCostActions(prisma: PrismaClient, tenantId: string, actions: readonly LinkAction[]): Promise<void> {
  const changed = actions.filter((action) => action.chargePeriodStart !== undefined && action.metricIdentityHash !== undefined && !isUnchanged(action));
  if (changed.length === 0) return;
  const values = changed.map((action) => Prisma.sql`(
    CAST(${action.chargePeriodStart} AS timestamptz),
    CAST(${action.metricIdentityHash} AS text),
    CAST(${action.cloudResourceId ?? null} AS text),
    CAST(${action.reason ?? null} AS text)
  )`);
  await prisma.$executeRaw(Prisma.sql`
    UPDATE cost_metrics AS target
       SET cloud_resource_id = source.cloud_resource_id,
           resource_link_reason = source.resource_link_reason
      FROM (VALUES ${Prisma.join(values)}) AS source(charge_period_start, metric_identity_hash, cloud_resource_id, resource_link_reason)
     WHERE target.tenant_id = ${tenantId}
       AND target.charge_period_start = source.charge_period_start
       AND target.metric_identity_hash = source.metric_identity_hash
  `);
}

async function applyMetricSampleActions(prisma: PrismaClient, tenantId: string, actions: readonly LinkAction[]): Promise<void> {
  await applyIdActions(prisma, tenantId, 'resource_metric_samples', actions);
}

async function applyRecommendationActions(prisma: PrismaClient, tenantId: string, actions: readonly LinkAction[]): Promise<void> {
  await applyIdActions(prisma, tenantId, 'recommendations', actions);
}

async function applyIdActions(prisma: PrismaClient, tenantId: string, table: 'resource_metric_samples' | 'recommendations', actions: readonly LinkAction[]): Promise<void> {
  const changed = actions.filter((action) => action.id !== undefined && !isUnchanged(action));
  if (changed.length === 0) return;
  const values = changed.map((action) => Prisma.sql`(
    ${action.id},
    CAST(${action.cloudResourceId ?? null} AS text),
    CAST(${action.reason ?? null} AS text)
  )`);
  await prisma.$executeRaw(Prisma.sql`
    UPDATE ${Prisma.raw(table)} AS target
       SET cloud_resource_id = source.cloud_resource_id,
           resource_link_reason = source.resource_link_reason
      FROM (VALUES ${Prisma.join(values)}) AS source(id, cloud_resource_id, resource_link_reason)
     WHERE target.tenant_id = ${tenantId}
       AND target.id = source.id
  `);
}

function isUnchanged(action: LinkAction): boolean {
  return action.cloudResourceId === action.currentCloudResourceId
    && (action.reason ?? null) === action.currentReason;
}

function isServiceLevelCost(resourceId: string, providerRaw: unknown): boolean {
  if (isOciAggregateResourceId(resourceId)) return true;
  if (resourceId.trim() !== '') return false;
  const raw = readRecord(providerRaw)?.['raw'];
  const sourceRow = readRecord(raw) ?? readRecord(providerRaw);
  return sourceRow !== undefined && !Object.prototype.hasOwnProperty.call(sourceRow, 'ResourceId');
}

function isServiceRecommendation(type: string): boolean {
  return /service|usage/i.test(type);
}

function readString(value: unknown, key: string): string | undefined {
  const record = readRecord(value);
  const candidate = record?.[key];
  return normalizeExternalResourceId(candidate);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readArgument(prefix: string): string | undefined {
  const argumentName = prefix.replace(/=$/, '');
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  const positionalIndex = process.argv.indexOf(argumentName);
  const positional = positionalIndex >= 0 ? process.argv[positionalIndex + 1] : undefined;
  const suffix = argumentName.slice(2).replaceAll('-', '_').toUpperCase();
  const configured = process.env[`RESOURCE_LINK_RECONCILE_${suffix}`]
    ?? process.env[`npm_config_${suffix.toLowerCase()}`]
    ?? process.env[`NPM_CONFIG_${suffix}`];
  const value = inline !== undefined
    ? inline.slice(prefix.length)
    : positional !== undefined && !positional.startsWith('--')
      ? positional
      : configured;
  const parsed = value?.trim();
  return parsed === undefined || parsed === '' ? undefined : parsed;
}

function assertSafeScope(tenantFilter: string | undefined): void {
  const runningThroughNpm = process.env['npm_lifecycle_event'] !== undefined;
  const explicitAll = process.argv.includes('--all') || process.env['RESOURCE_LINK_RECONCILE_ALL'] === 'true';
  if (runningThroughNpm && tenantFilter === undefined && !explicitAll) {
    throw new Error('El script npm exige --tenant=<id> o RESOURCE_LINK_RECONCILE_ALL=true para reconciliar todos los tenants de forma explícita.');
  }
}

function parseBatchSize(): number {
  const raw = readArgument('--batch-size=');
  if (raw === undefined) return defaultBatchSize;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5000) {
    throw new Error('--batch-size must be an integer between 1 and 5000');
  }
  return parsed;
}

function readOnlyTable(): 'all' | 'cost_metrics' | 'resource_metric_samples' | 'recommendations' {
  const value = readArgument('--only=') ?? 'all';
  if (value === 'all' || value === 'cost_metrics' || value === 'resource_metric_samples' || value === 'recommendations') {
    return value;
  }
  throw new Error('--only debe ser all, cost_metrics, resource_metric_samples o recommendations.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
