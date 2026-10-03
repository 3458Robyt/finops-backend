import { hashOciMetricDimensions } from './oci/OciMetricDimensions.js';

export function mergeEnabledMetricDefinitions(
  metadataValue: unknown,
  definitions: readonly {
    readonly compartmentId: string;
    readonly namespace: string;
    readonly metricName: string;
    readonly externalResourceId: string;
    readonly regionId: string | null;
    readonly dimensions: unknown;
    readonly metricUnit: string | null;
    readonly statistics: unknown;
  }[],
): Record<string, unknown> | undefined {
  const metadata = metadataValue !== null && typeof metadataValue === 'object' && !Array.isArray(metadataValue)
    ? { ...(metadataValue as Record<string, unknown>) }
    : {};
  const legacyDefinitions = readLegacyDefinitions(metadata);
  const enabled = definitions
    .filter((definition) => definition.externalResourceId.trim() !== '')
    .map((definition) => {
      const dimensions = readStringDimensions(definition.dimensions);
      const regionId = definition.regionId?.trim() || null;
      const existing = legacyDefinitions.find((candidate) =>
        candidate['compartmentId'] === definition.compartmentId
        && candidate['namespace'] === definition.namespace
        && candidate['metricName'] === definition.metricName
        && (candidate['resourceId'] ?? candidate['resource_id'] ?? '') === definition.externalResourceId
        && (candidate['regionId'] === undefined || candidate['regionId'] === null || candidate['regionId'] === ''
          || candidate['regionId'] === regionId)
        && hashOciMetricDimensions(readStringDimensions(candidate['dimensions'])) === hashOciMetricDimensions(dimensions));
      return {
        compartmentId: definition.compartmentId,
        namespace: definition.namespace,
        metricName: definition.metricName,
        resourceId: definition.externalResourceId,
        ...(regionId === null ? {} : { regionId }),
        ...(dimensions === undefined ? {} : { dimensions }),
        ...(definition.metricUnit === null ? {} : { unit: definition.metricUnit }),
        statistics: definition.statistics,
        ...(typeof existing?.['query'] === 'string' ? { query: existing['query'] } : {}),
      };
    });
  if (enabled.length > 0) metadata['ociMetricDefinitions'] = enabled;
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function readLegacyDefinitions(metadata: Record<string, unknown>): readonly Record<string, unknown>[] {
  const definitions = metadata['ociMetricDefinitions'];
  return Array.isArray(definitions)
    ? definitions.filter((value): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value))
    : [];
}

function readStringDimensions(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === 'string')
    ? Object.fromEntries(entries) as Record<string, string>
    : undefined;
}
