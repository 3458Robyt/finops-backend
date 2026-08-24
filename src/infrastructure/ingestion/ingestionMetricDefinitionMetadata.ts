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
  const enabled = definitions
    .filter((definition) => definition.externalResourceId.trim() !== '')
    .map((definition) => ({
      compartmentId: definition.compartmentId,
      namespace: definition.namespace,
      metricName: definition.metricName,
      resourceId: definition.externalResourceId,
      ...(definition.regionId === null ? {} : { regionId: definition.regionId }),
      ...(definition.dimensions !== null && typeof definition.dimensions === 'object' && !Array.isArray(definition.dimensions)
        ? { dimensions: definition.dimensions }
        : {}),
      ...(definition.metricUnit === null ? {} : { unit: definition.metricUnit }),
      statistics: definition.statistics,
    }));
  if (enabled.length > 0) metadata['ociMetricDefinitions'] = enabled;
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}
