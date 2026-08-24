import type {
  CloudIngestionJobContext,
  NormalizedCloudResource,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import type { OciResourceSearchSummary } from './OciSdkContracts.js';

export function normalizeOciSearchResource(
  job: CloudIngestionJobContext,
  summary: OciResourceSearchSummary,
): NormalizedCloudResource | undefined {
  const externalResourceId = summary.identifier.trim();
  if (externalResourceId === '') return undefined;
  const catalog = classifyResourceType(summary.resourceType);
  const regionId = readRegionId(summary, job.connection.defaultRegion);
  const timeCreated = normalizeTimestamp(summary.timeCreated);
  return {
    tenantId: job.tenantId,
    cloudConnectionId: job.cloudConnectionId,
    provider: 'OCI',
    externalResourceId,
    name: summary.displayName?.trim() || externalResourceId,
    resourceType: catalog.resourceType,
    serviceName: catalog.serviceName,
    ...(regionId !== undefined ? { regionId } : {}),
    status: normalizeOciResourceStatus(summary.lifecycleState),
    tags: mergeOciTags(summary.freeformTags, summary.definedTags),
    rawResource: {
      source: 'OCI_RESOURCE_SEARCH',
      normalizerVersion: 'oci-resource-search-v1',
      ociResourceType: summary.resourceType,
      compartmentId: summary.compartmentId,
      ...(summary.availabilityDomain !== undefined ? { availabilityDomain: summary.availabilityDomain } : {}),
      ...(timeCreated !== undefined ? { timeCreated } : {}),
      ...(summary.lifecycleState !== undefined ? { lifecycleState: summary.lifecycleState } : {}),
      ...(summary.additionalDetails !== undefined ? { additionalDetails: summary.additionalDetails } : {}),
    },
  };
}

function normalizeTimestamp(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function readRegionId(summary: OciResourceSearchSummary, fallback?: string): string | undefined {
  const details = summary.additionalDetails;
  const region = details?.['regionId'] ?? details?.['region'];
  return typeof region === 'string' && region.trim() !== '' ? region.trim() : fallback;
}

export function normalizeOciResourceStatus(status: string | undefined): NormalizedCloudResource['status'] {
  const normalized = status?.toUpperCase();
  if (normalized === 'ACTIVE' || normalized === 'RUNNING' || normalized === 'AVAILABLE') return 'ACTIVE';
  if (normalized === 'STOPPED' || normalized === 'STOPPING') return 'STOPPED';
  if (normalized === 'TERMINATED' || normalized === 'DELETED') return 'TERMINATED';
  return 'UNKNOWN';
}

export function mergeOciTags(
  freeform: Readonly<Record<string, unknown>> | undefined,
  defined: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  return { ...(freeform ?? {}), ...(defined !== undefined ? { definedTags: defined } : {}) };
}

export function ociInventorySourcePriority(resource: NormalizedCloudResource): number {
  switch (resource.rawResource?.['source']) {
    case 'OCI_INVENTORY_METADATA': return 4;
    case 'OCI_COMPUTE_SDK': return 3;
    case 'OCI_RESOURCE_SEARCH': return 2;
    case 'OCI_METRIC_DEFINITION': return 1;
    default: return 0;
  }
}

function classifyResourceType(resourceType: string): {
  readonly resourceType: string;
  readonly serviceName: string;
} {
  switch (resourceType.toLowerCase()) {
    case 'instance': return { resourceType: 'COMPUTE_INSTANCE', serviceName: 'Oracle Compute' };
    case 'bootvolume': return { resourceType: 'BOOT_VOLUME', serviceName: 'Oracle Block Volume' };
    case 'bootvolumebackup': return { resourceType: 'BOOT_VOLUME_BACKUP', serviceName: 'Oracle Block Volume' };
    case 'vnic': return { resourceType: 'VNIC', serviceName: 'Oracle Networking' };
    default: return { resourceType: resourceType.toUpperCase(), serviceName: 'Oracle Cloud Infrastructure' };
  }
}
