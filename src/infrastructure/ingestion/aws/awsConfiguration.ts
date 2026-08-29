import type {
  CloudIngestionJobContext,
  CloudIngestionResult,
  NormalizedCloudResource,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import {
  optionalString,
  readBoundedPositiveInteger,
  readObjectArray,
  readStringArray,
  requireString,
} from '../providerConfig.js';
import type {
  AwsFocusExportLocation,
  AwsFocusExportObject,
  AwsMetricDefinition,
} from './awsContracts.js';
import { safeErrorMessage } from '../../../application/observability/safeError.js';

export function readAwsMetricDefinitions(job: CloudIngestionJobContext): readonly AwsMetricDefinition[] {
  return readObjectArray(job.connection.metadata, 'awsMetricDefinitions').map((item) => {
    const unit = optionalString(item['unit']);
    const region = optionalString(item['region']);
    return {
      externalResourceId: requireString(item['externalResourceId'], 'awsMetricDefinitions.externalResourceId'),
      namespace: requireString(item['namespace'], 'awsMetricDefinitions.namespace'),
      metricName: requireString(item['metricName'], 'awsMetricDefinitions.metricName'),
      stat: optionalString(item['stat']) ?? 'Average',
      ...(unit !== undefined ? { unit } : {}),
      ...(region !== undefined ? { region } : {}),
      dimensions: readObjectArray(item, 'dimensions').map((dimension) => ({
        Name: requireString(dimension['Name'], 'awsMetricDefinitions.dimensions.Name'),
        Value: requireString(dimension['Value'], 'awsMetricDefinitions.dimensions.Value'),
      })),
    };
  });
}

export interface AwsMetricDiscoveryConfig {
  readonly namespaces: readonly string[];
  readonly metricNames: readonly string[];
  readonly statistics: readonly string[];
}

/**
 * Reads the bounded CloudWatch discovery catalogue. We intentionally avoid
 * asking ListMetrics for every namespace in an account: discovery is a
 * bootstrap fallback and the persisted definitions remain the authoritative
 * configuration for future, higher-volume runs.
 */
export function readAwsMetricDiscoveryConfig(job: CloudIngestionJobContext): AwsMetricDiscoveryConfig {
  const metadata = job.connection.metadata;
  const namespaces = readStringArray(metadata?.['awsMetricDiscoveryNamespaces'])
    .filter((value) => value.includes('/'));
  const metricNames = readStringArray(metadata?.['awsMetricDiscoveryNames']);
  const statistics = readStringArray(metadata?.['awsMetricDiscoveryStatistics']);
  return {
    namespaces: namespaces.length > 0 ? namespaces : ['AWS/EC2', 'AWS/EBS'],
    metricNames: metricNames.length > 0
      ? metricNames
      : ['CPUUtilization', 'NetworkIn', 'NetworkOut', 'DiskReadBytes', 'DiskWriteBytes', 'StatusCheckFailed', 'VolumeReadOps', 'VolumeWriteOps', 'VolumeIdleTime'],
    statistics: statistics.length > 0 ? statistics : ['Average'],
  };
}

export function readAwsFocusObjects(job: CloudIngestionJobContext): readonly AwsFocusExportObject[] {
  return readObjectArray(job.connection.metadata, 'awsFocusExportObjects').map((item) => {
    const region = optionalString(item['region']);
    return {
      bucket: requireString(item['bucket'], 'awsFocusExportObjects.bucket'),
      key: requireString(item['key'], 'awsFocusExportObjects.key'),
      focusVersion: optionalString(item['focusVersion']) ?? '1.0',
      ...(region !== undefined ? { region } : {}),
    };
  });
}

export function readAwsFocusLocations(job: CloudIngestionJobContext): readonly AwsFocusExportLocation[] {
  return readObjectArray(job.connection.metadata, 'awsFocusExportLocations').map((item) => {
    const region = optionalString(item['region']);
    return {
      bucket: requireString(item['bucket'], 'awsFocusExportLocations.bucket'),
      prefix: requireString(item['prefix'], 'awsFocusExportLocations.prefix'),
      focusVersion: optionalString(item['focusVersion']) ?? '1.0',
      maxObjects: readBoundedPositiveInteger(item['maxObjects'], 10_000, 1, 10_000),
      ...(region !== undefined ? { region } : {}),
    };
  });
}

export function readAwsInventoryRegions(job: CloudIngestionJobContext, defaultRegion: string): readonly string[] {
  const configured = readStringArray(job.connection.metadata?.['awsInventoryRegions']);
  const metricRegions = readAwsMetricDefinitions(job)
    .map((definition) => definition.region)
    .filter((region): region is string => region !== undefined);
  return [...new Set([...configured, ...metricRegions, defaultRegion])];
}

export function mergeAwsInventoryResources(
  resources: readonly NormalizedCloudResource[],
): readonly NormalizedCloudResource[] {
  const byExternalResourceId = new Map<string, NormalizedCloudResource>();
  for (const resource of resources) {
    const previous = byExternalResourceId.get(resource.externalResourceId);
    if (previous === undefined || previous.rawResource?.['source'] === 'AWS_METRIC_DEFINITION') {
      byExternalResourceId.set(resource.externalResourceId, resource);
    }
  }
  return [...byExternalResourceId.values()];
}

export function inferAwsResourceType(definition: AwsMetricDefinition): string {
  if (definition.namespace.toLowerCase().includes('ec2')) return 'COMPUTE_INSTANCE';
  if (definition.namespace.toLowerCase().includes('ebs')) return 'BLOCK_VOLUME';
  return 'UNKNOWN';
}

export function inferAwsServiceName(definition: AwsMetricDefinition): string {
  if (definition.namespace.toLowerCase().includes('ec2')) return 'Amazon EC2';
  if (definition.namespace.toLowerCase().includes('ebs')) return 'Amazon EBS';
  return 'UNKNOWN';
}

export function normalizeAwsResourceStatus(status: string | undefined): NormalizedCloudResource['status'] {
  const normalized = status?.toUpperCase();
  if (normalized === 'ACTIVE' || normalized === 'RUNNING' || normalized === 'AVAILABLE' || normalized === 'IN-USE' || normalized === 'IN_USE') return 'ACTIVE';
  if (normalized === 'STOPPED' || normalized === 'STOPPING') return 'STOPPED';
  if (normalized === 'TERMINATED' || normalized === 'DELETED') return 'TERMINATED';
  return 'UNKNOWN';
}

export function groupAwsMetricsByRegion(
  definitions: readonly AwsMetricDefinition[],
  defaultRegion: string,
): ReadonlyMap<string, readonly AwsMetricDefinition[]> {
  const grouped = new Map<string, AwsMetricDefinition[]>();
  for (const definition of definitions) {
    const region = definition.region ?? defaultRegion;
    grouped.set(region, [...(grouped.get(region) ?? []), definition]);
  }
  return grouped;
}

export function chunkAwsItems<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export function awsTagsToRecord(
  tags: readonly { readonly Key?: string; readonly Value?: string }[] | undefined,
): Readonly<Record<string, unknown>> {
  const record: Record<string, unknown> = {};
  for (const tag of tags ?? []) {
    if (tag.Key !== undefined && tag.Value !== undefined) record[tag.Key] = tag.Value;
  }
  return record;
}

export function isAwsFocusObjectName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.csv') || lower.endsWith('.csv.gz');
}

export function isAwsFocusManifestName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('manifest.json') || lower.endsWith('-manifest.json');
}

export function safeAwsProviderError(error: unknown): string {
  return safeErrorMessage(error);
}

export function emptyAwsIngestionResult(
  apiCallCount: number,
  warnings: readonly string[],
  coverage: Readonly<Record<string, unknown>>,
): CloudIngestionResult {
  return {
    apiCallCount,
    objectsProcessed: 0,
    focusRows: [],
    resources: [],
    metricSamples: [],
    warnings,
    coverage,
  };
}
