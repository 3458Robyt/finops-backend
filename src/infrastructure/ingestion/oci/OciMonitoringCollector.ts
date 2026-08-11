import type {
  CloudIngestionJobContext,
  CloudIngestionResult,
  NormalizedResourceMetricSample,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { optionalString, readObjectArray, readStringArray, requireString } from '../providerConfig.js';
import type { OciMetricDefinition, OciMonitoringClient } from './OciSdkContracts.js';

export interface OciMonitoringDependencies {
  readonly createClient: (job: CloudIngestionJobContext) => OciMonitoringClient;
  readonly withRetry: <T>(operation: () => Promise<T>) => Promise<T>;
}

export async function collectOciTechnicalMetrics(
  job: CloudIngestionJobContext,
  dependencies: OciMonitoringDependencies,
): Promise<CloudIngestionResult> {
  const definitions = readOciMetricDefinitions(job);
  if (definitions.length === 0) {
    return emptyMetricResult([
      'No OCI metric definitions configured in cloud connection metadata key ociMetricDefinitions.',
    ], {
      metricDefinitions: 0,
      supportedNamespaces: ['oci_computeagent', 'oci_vmi_resource_utilization'],
    });
  }

  const client = dependencies.createClient(job);
  const samples: NormalizedResourceMetricSample[] = [];
  let apiCallCount = 0;

  try {
    for (const definition of definitions) {
      apiCallCount += 1;
      const query = definition.query ?? buildOciResourceMetricQuery(definition);
      const response = await dependencies.withRetry(() => client.summarizeMetricsData({
        compartmentId: definition.compartmentId,
        summarizeMetricsDataDetails: {
          namespace: definition.namespace,
          query,
          startTime: job.targetStart,
          endTime: job.targetEnd,
          resolution: '30m',
        },
      }));

      for (const metric of response.items ?? response.summarizedMetricsData ?? []) {
        const externalResourceId = metric.dimensions?.['resourceId'] ?? definition.resourceId;
        for (const point of metric.aggregatedDatapoints ?? []) {
          if (point.timestamp === undefined || point.value === undefined) continue;

          samples.push({
            tenantId: job.tenantId,
            cloudConnectionId: job.cloudConnectionId,
            provider: 'OCI',
            externalResourceId,
            metricName: metric.name ?? definition.metricName,
            value: point.value,
            sampledAt: point.timestamp instanceof Date ? point.timestamp : new Date(point.timestamp),
            granularitySeconds: 1800,
            ...(definition.unit !== undefined ? { metricUnit: definition.unit } : {}),
            rawMetric: {
              namespace: metric.namespace ?? definition.namespace,
              query,
              compartmentId: definition.compartmentId,
            },
          });
        }
      }
    }
  } finally {
    client.close?.();
  }

  return {
    apiCallCount,
    objectsProcessed: 0,
    focusRows: [],
    resources: [],
    metricSamples: samples,
    warnings: samples.length === 0
      ? ['OCI Monitoring returned no datapoints for the configured metric definitions.']
      : [],
    coverage: {
      requestedStart: job.targetStart.toISOString(),
      requestedEnd: job.targetEnd.toISOString(),
      granularitySeconds: 1800,
      datapointsReturned: samples.length,
      metricDefinitions: definitions.length,
      samples: samples.length,
      memoryRequiresComputeAgent: true,
      agentlessCpuNamespace: 'oci_vmi_resource_utilization',
    },
  };
}

export function readOciMetricDefinitions(
  job: CloudIngestionJobContext,
): readonly OciMetricDefinition[] {
  return readObjectArray(job.connection.metadata, 'ociMetricDefinitions').map((item) => {
    const query = optionalString(item['query']);
    const unit = optionalString(item['unit']);
    return {
      compartmentId: requireString(item['compartmentId'], 'ociMetricDefinitions.compartmentId'),
      namespace: optionalString(item['namespace']) ?? 'oci_computeagent',
      metricName: requireString(item['metricName'], 'ociMetricDefinitions.metricName'),
      resourceId: optionalString(item['resourceId'])
        ?? readStringArray(item['resourceIds'])[0]
        ?? job.connection.rootExternalId,
      ...(query !== undefined ? { query } : {}),
      ...(unit !== undefined ? { unit } : {}),
    };
  });
}

export function buildOciResourceMetricQuery(definition: OciMetricDefinition): string {
  return `${definition.metricName}[30m]{resourceId = "${definition.resourceId}"}.mean()`;
}

function emptyMetricResult(
  warnings: readonly string[],
  coverage: Readonly<Record<string, unknown>>,
): CloudIngestionResult {
  return {
    apiCallCount: 0,
    objectsProcessed: 0,
    focusRows: [],
    resources: [],
    metricSamples: [],
    warnings,
    coverage,
  };
}
