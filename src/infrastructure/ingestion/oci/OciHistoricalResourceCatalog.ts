import type {
  CloudIngestionJobContext,
  NormalizedCloudResource,
  NormalizedFocusCostLineItem,
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
      source: 'OCI_FOCUS_HISTORICAL_REFERENCE',
      normalizerVersion: 'oci-focus-history-v1',
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

export function classifySupportedOciResourceId(resourceId: string): {
  readonly resourceType: string;
  readonly serviceName: string;
} | undefined {
  const match = /^ocid1\.([a-z0-9]+)\./i.exec(resourceId.trim());
  return match?.[1] === undefined ? undefined : supportedHistoricalTypes.get(match[1].toLowerCase());
}

