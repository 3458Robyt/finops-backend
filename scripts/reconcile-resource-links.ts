import 'dotenv/config';

import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { runWithDatabaseContext } from '../src/infrastructure/database/tenantContext.js';
import {
  normalizeExternalResourceId,
  resolveExactResourceLink,
  resourceLookupKey,
  type ResourceLinkReasonCode,
} from '../src/domain/models/ResourceLinkage.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { Prisma } from '../src/generated/prisma/client.js';

const defaultBatchSize = 500;
const reasonCodes: readonly ResourceLinkReasonCode[] = [
  'EMPTY_RESOURCE_ID',
  'INVENTORY_RESOURCE_NOT_FOUND',
  'CONNECTION_NOT_AVAILABLE',
  'AMBIGUOUS_RESOURCE_ID',
  'SERVICE_LEVEL_COST',
  'INVALID_EXISTING_REFERENCE',
];

interface LinkCounters {
  examined: number;
  linked: number;
  alreadyLinked: number;
  updated: number;
  unresolved: number;
  reasons: Record<ResourceLinkReasonCode, number>;
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

function createCounters(): LinkCounters {
  return {
    examined: 0,
    linked: 0,
    alreadyLinked: 0,
    updated: 0,
    unresolved: 0,
    reasons: Object.fromEntries(reasonCodes.map((code) => [code, 0])) as Record<ResourceLinkReasonCode, number>,
  };
}

async function main(): Promise<void> {
  const prisma = getPrismaClient();
  const apply = process.argv.includes('--apply');
  const batchSize = parseBatchSize();
  const tenantFilter = readArgument('--tenant=');

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
        () => reconcileTenant(prisma, tenant.id, batchSize, apply),
      );
      results.push(result);
    }

    console.log(JSON.stringify({
      success: true,
      mode: apply ? 'APPLY' : 'DRY_RUN',
      batchSize,
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
): Promise<Record<string, unknown>> {
  const costMetrics = await reconcileCostMetrics(prisma, tenantId, batchSize, apply);
  const metricSamples = await reconcileMetricSamples(prisma, tenantId, batchSize, apply);
  const recommendations = await reconcileRecommendations(prisma, tenantId, batchSize, apply);
  const summary = { costMetrics, metricSamples, recommendations };

  if (apply) {
    const hasUnresolved = [costMetrics, metricSamples, recommendations]
      .some((table) => table.unresolved > 0);
    await prisma.dataQualityCheck.create({
      data: {
        tenantId,
        sourceType: 'INVENTORY',
        checkName: 'resource_linkage_reconciliation',
        status: hasUnresolved ? 'WARNING' : 'PASSED',
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

async function reconcileCostMetrics(
  prisma: PrismaClient,
  tenantId: string,
  batchSize: number,
  apply: boolean,
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

    const resourceIndex = await loadResourceIndex(prisma, tenantId, rows.map((row) => ({
      cloudConnectionId: row.cloud_connection_id,
      externalResourceId: row.resource_id,
    })));
    const existingResources = await loadResourcesByIds(prisma, tenantId, rows.map((row) => row.cloud_resource_id));
    const actions = rows.map((row) => ({
      chargePeriodStart: row.charge_period_start,
      metricIdentityHash: row.metric_identity_hash,
      ...resolveAction({
        cloudConnectionId: row.cloud_connection_id,
        externalResourceId: row.resource_id,
        currentCloudResourceId: row.cloud_resource_id,
        currentReason: row.resource_link_reason,
        existingResource: existingResources.get(row.cloud_resource_id ?? ''),
        resourceIndex,
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

    const resourceIndex = await loadResourceIndex(prisma, tenantId, rows);
    const existingResources = await loadResourcesByIds(prisma, tenantId, rows.map((row) => row.cloudResourceId));
    const actions = rows.map((row) => ({
      id: row.id,
      ...resolveAction({
        cloudConnectionId: row.cloudConnectionId,
        externalResourceId: row.externalResourceId,
        currentCloudResourceId: row.cloudResourceId,
        currentReason: row.resourceLinkReason,
        existingResource: existingResources.get(row.cloudResourceId ?? ''),
        resourceIndex,
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

    const evidenceResourceIds = rows
      .map((row) => readString(row.evidence, 'cloudResourceId'))
      .filter((value): value is string => value !== undefined);
    const existingResources = await loadResourcesByIds(prisma, tenantId, [
      ...rows.map((row) => row.cloudResourceId),
      ...evidenceResourceIds,
    ]);
    const actions = rows.map((row) => ({
      id: row.id,
      ...resolveRecommendationAction(row, existingResources),
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
      && normalizeExternalResourceId(existing.externalResourceId) === normalizedExternalId;
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

async function loadResourceIndex(
  prisma: PrismaClient,
  tenantId: string,
  rows: readonly { readonly cloudConnectionId: string | null; readonly externalResourceId: unknown }[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const connectionIds = [...new Set(rows.map((row) => row.cloudConnectionId).filter((value): value is string => value !== null && value.trim() !== ''))];
  const externalResourceIds = [...new Set(rows.map((row) => normalizeExternalResourceId(row.externalResourceId)).filter((value): value is string => value !== undefined))];
  if (connectionIds.length === 0 || externalResourceIds.length === 0) return new Map();

  const resources = await prisma.cloudResource.findMany({
    where: { tenantId, cloudConnectionId: { in: connectionIds }, externalResourceId: { in: externalResourceIds } },
    select: { id: true, tenantId: true, cloudConnectionId: true, externalResourceId: true },
  });
  const index = new Map<string, string[]>();
  for (const resource of resources) {
    const key = resourceLookupKey(resource.cloudConnectionId, normalizeExternalResourceId(resource.externalResourceId) ?? resource.externalResourceId);
    index.set(key, [...(index.get(key) ?? []), resource.id]);
  }
  return index;
}

async function loadResourcesByIds(
  prisma: PrismaClient,
  tenantId: string,
  ids: readonly (string | null)[],
): Promise<ReadonlyMap<string, ResourceRow>> {
  const resourceIds = [...new Set(ids.filter((value): value is string => value !== null && value.trim() !== ''))];
  if (resourceIds.length === 0) return new Map();
  const resources = await prisma.cloudResource.findMany({
    where: { tenantId, id: { in: resourceIds } },
    select: { id: true, tenantId: true, cloudConnectionId: true, externalResourceId: true },
  });
  return new Map(resources.map((resource) => [resource.id, resource]));
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

    counters.unresolved += 1;
    if (action.reason !== undefined) {
      counters.reasons[action.reason] += 1;
    }
    if (action.currentCloudResourceId !== null || action.currentReason !== action.reason) {
      counters.updated += 1;
    } else {
      counters.alreadyLinked += 1;
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
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  const parsed = value?.slice(prefix.length).trim();
  return parsed === undefined || parsed === '' ? undefined : parsed;
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

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
