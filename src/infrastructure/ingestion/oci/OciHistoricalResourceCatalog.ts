import type {
  CloudIngestionJobContext,
  NormalizedCloudResource,
  NormalizedFocusCostLineItem,
  NormalizedProviderCostLineItem,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';

const supportedHistoricalTypes: ReadonlyMap<string, { readonly resourceType: string; readonly serviceName: string }> = new Map([
  ['instance', { resourceType: 'COMPUTE_INSTANCE', serviceName: 'Oracle Compute' }],
  ['bootvolume', { resourceType: 'BOOT_VOLUME', serviceName: 'Oracle Block Volume' }],
  ['bootvolumebackup', { resourceType: 'BOOT_VOLUME_BACKUP', serviceName: 'Oracle Block Volume' }],
  ['vnic', { resourceType: 'VNIC', serviceName: 'Oracle Networking' }],
] as const);

export function buildHistoricalOciResources(
  job: CloudIngestionJobContext,
  rows: readonly NormalizedFocusCostLineItem[],
): readonly NormalizedCloudResource[] {
  return buildHistoricalResources(job, rows, 'OCI_FOCUS_HISTORICAL_REFERENCE', 'oci-focus-history-v1');
}

/**
 * Builds exact historical references for provider billing rows that carry an
 * OCI OCID but are no longer returned by Resource Search. These references are
 * intentionally UNKNOWN: they make cost lineage complete without presenting
 * a cost-only resource as live inventory or technical evidence.
 */
export function buildHistoricalOciProviderResources(
  job: CloudIngestionJobContext,
  rows: readonly NormalizedProviderCostLineItem[],
): readonly NormalizedCloudResource[] {
  if (job.connection.providerCode !== 'oci') return [];
  const resources = new Map<string, ProviderHistoricalResourceAccumulator>();

  for (const row of rows) {
    const externalResourceId = row.resourceId.trim();
    if (!isOciHistoricalResourceId(externalResourceId)) continue;
    const current = resources.get(externalResourceId);
    if (current === undefined) {
      resources.set(externalResourceId, {
        externalResourceId,
        resourceType: ociResourceType(externalResourceId),
        serviceName: row.serviceName,
        ...(row.resourceName === undefined ? {} : { name: row.resourceName }),
        ...(row.regionId === undefined ? {} : { regionId: row.regionId }),
        firstSeenAt: row.chargePeriodStart,
        lastSeenAt: row.chargePeriodEnd,
        raw: {
          source: 'OCI_USAGE_API_HISTORICAL_REFERENCE',
          normalizerVersion: 'oci-usage-history-v1',
          historicalReference: true,
          observedServiceName: row.serviceName,
          compartmentId: row.compartmentId,
          skuName: row.skuName,
          skuPartNumber: row.skuPartNumber,
          resourceName: row.resourceName,
        },
      });
      continue;
    }
    if (row.chargePeriodStart < current.firstSeenAt) current.firstSeenAt = row.chargePeriodStart;
    if (row.chargePeriodEnd > current.lastSeenAt) current.lastSeenAt = row.chargePeriodEnd;
    if (current.name === undefined && row.resourceName !== undefined) current.name = row.resourceName;
    if (current.regionId === undefined && row.regionId !== undefined) current.regionId = row.regionId;
  }

  return [...resources.values()].map((value) => ({
    tenantId: job.tenantId,
    cloudConnectionId: job.cloudConnectionId,
    provider: 'OCI',
    externalResourceId: value.externalResourceId,
    ...(value.name === undefined ? {} : { name: value.name }),
    resourceType: value.resourceType,
    serviceName: value.serviceName,
    ...(value.regionId === undefined ? {} : { regionId: value.regionId }),
    status: 'UNKNOWN',
    firstSeenAt: value.firstSeenAt,
    lastSeenAt: value.lastSeenAt,
    rawResource: {
      ...value.raw,
      evidencePeriodStart: value.firstSeenAt.toISOString(),
      evidencePeriodEnd: value.lastSeenAt.toISOString(),
    },
  }));
}

/** OCI Usage API also emits aggregate metric identifiers, not resource IDs. */
export function isOciAggregateResourceId(resourceId: string | undefined): boolean {
  return resourceId !== undefined && /^oci_[a-z0-9_]+$/i.test(resourceId.trim());
}

export function isOciHistoricalResourceId(resourceId: string | undefined): boolean {
  return resourceId !== undefined && /^ocid1\.[a-z0-9]+\./i.test(resourceId.trim());
}

function buildHistoricalResources(
  job: CloudIngestionJobContext,
  rows: readonly NormalizedFocusCostLineItem[],
  source: string,
  normalizerVersion: string,
): readonly NormalizedCloudResource[] {
  if (job.connection.providerCode !== 'oci') return [];
  const resources = new Map<string, HistoricalResourceAccumulator>();

  for (const row of rows) {
    const catalog = classifySupportedOciResourceId(row.resourceId);
    if (catalog === undefined) continue;
    const current = resources.get(row.resourceId);
    if (current === undefined) {
      resources.set(row.resourceId, {
        row,
        resourceType: catalog.resourceType,
        serviceName: catalog.serviceName,
        firstSeenAt: row.chargePeriodStart,
        lastSeenAt: row.chargePeriodEnd,
      });
      continue;
    }
    if (row.chargePeriodStart < current.firstSeenAt) current.firstSeenAt = row.chargePeriodStart;
    if (row.chargePeriodEnd > current.lastSeenAt) current.lastSeenAt = row.chargePeriodEnd;
  }

  return [...resources.entries()].map(([externalResourceId, value]) => ({
    tenantId: job.tenantId,
    cloudConnectionId: job.cloudConnectionId,
    provider: 'OCI',
    externalResourceId,
    name: externalResourceId,
    resourceType: value.resourceType,
    serviceName: value.serviceName,
    ...(value.row.regionId !== undefined ? { regionId: value.row.regionId } : {}),
    status: 'UNKNOWN',
    ...(value.row.tags !== undefined ? { tags: value.row.tags } : {}),
    firstSeenAt: value.firstSeenAt,
    lastSeenAt: value.lastSeenAt,
    rawResource: {
      source,
      normalizerVersion,
      historicalReference: true,
      observedServiceName: value.row.serviceName,
      evidencePeriodStart: value.firstSeenAt.toISOString(),
      evidencePeriodEnd: value.lastSeenAt.toISOString(),
    },
  }));
}

interface HistoricalResourceAccumulator {
  readonly row: NormalizedFocusCostLineItem;
  readonly resourceType: string;
  readonly serviceName: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

interface ProviderHistoricalResourceAccumulator {
  readonly externalResourceId: string;
  readonly resourceType: string;
  readonly serviceName: string;
  readonly raw: Readonly<Record<string, unknown>>;
  name?: string;
  regionId?: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

function ociResourceType(resourceId: string): string {
  const match = /^ocid1\.([a-z0-9]+)\./i.exec(resourceId.trim());
  const type = match?.[1]?.toUpperCase();
  return type === undefined ? 'OCI_RESOURCE' : type === 'INSTANCE' ? 'COMPUTE_INSTANCE' : type;
}

export function classifySupportedOciResourceId(resourceId: string): {
  readonly resourceType: string;
  readonly serviceName: string;
} | undefined {
  const match = /^ocid1\.([a-z0-9]+)\./i.exec(resourceId.trim());
  return match?.[1] === undefined ? undefined : supportedHistoricalTypes.get(match[1].toLowerCase());
}

