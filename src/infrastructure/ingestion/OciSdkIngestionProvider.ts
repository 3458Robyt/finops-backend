import * as oci from 'oci-sdk';
import type {
  CloudIngestionJobContext,
  CloudIngestionProvider,
  CloudIngestionResult,
  NormalizedResourceMetricSample,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import { getCredential, optionalString, readObjectArray, readStringArray, requireString } from './providerConfig.js';

interface OciMetricDefinition {
  readonly compartmentId: string;
  readonly namespace: string;
  readonly metricName: string;
  readonly resourceId: string;
  readonly query?: string;
  readonly unit?: string;
}

interface OciMonitoringClient {
  summarizeMetricsData(request: unknown): Promise<{
    readonly summarizedMetricsData?: readonly {
      readonly namespace?: string;
      readonly name?: string;
      readonly dimensions?: Record<string, string>;
      readonly aggregatedDatapoints?: readonly {
        readonly timestamp?: Date | string;
        readonly value?: number;
      }[];
    }[];
  }>;
}

export class OciSdkIngestionProvider implements CloudIngestionProvider {
  public readonly providerCode = 'oci';

  public async collect(job: CloudIngestionJobContext): Promise<CloudIngestionResult> {
    if (job.sourceType === 'BILLING_EXPORT') {
      return this.emptyResult(0, [
        'OCI Cost Reports FOCUS are the canonical cost source, but Object Storage report parsing is pending for this SDK worker slice.',
      ], {
        costSource: 'OCI Cost Reports FOCUS',
        expectedRefreshHours: 6,
        implemented: false,
      });
    }

    if (job.sourceType === 'INVENTORY') {
      return this.emptyResult(0, [
        'OCI inventory collection is pending; only Monitoring technical metrics are implemented in this worker slice.',
      ], {
        inventoryImplemented: false,
      });
    }

    if (job.sourceType !== 'TECHNICAL_METRIC') {
      return this.emptyResult(0, [`Unsupported OCI ingestion source ${job.sourceType}`], {});
    }

    const definitions = this.readMetricDefinitions(job);
    if (definitions.length === 0) {
      return this.emptyResult(0, [
        'No OCI metric definitions configured in cloud connection metadata key ociMetricDefinitions.',
      ], {
        metricDefinitions: 0,
        supportedNamespaces: ['oci_computeagent', 'oci_vmi_resource_utilization'],
      });
    }

    const monitoringClient = this.createMonitoringClient(job);
    const samples: NormalizedResourceMetricSample[] = [];
    let apiCallCount = 0;

    for (const definition of definitions) {
      apiCallCount += 1;
      const query = definition.query ?? `${definition.metricName}[30m].mean()`;
      const response = await monitoringClient.summarizeMetricsData({
        compartmentId: definition.compartmentId,
        summarizeMetricsDataDetails: {
          namespace: definition.namespace,
          query,
          startTime: job.targetStart,
          endTime: job.targetEnd,
          resolution: '30m',
        },
      });

      for (const metric of response.summarizedMetricsData ?? []) {
        const externalResourceId = metric.dimensions?.['resourceId'] ?? definition.resourceId;
        for (const point of metric.aggregatedDatapoints ?? []) {
          if (point.timestamp === undefined || point.value === undefined) {
            continue;
          }

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

    return {
      apiCallCount,
      objectsProcessed: 0,
      focusRows: [],
      resources: [],
      metricSamples: samples,
      warnings: samples.length === 0 ? ['OCI Monitoring returned no datapoints for the configured metric definitions.'] : [],
      coverage: {
        metricDefinitions: definitions.length,
        samples: samples.length,
        memoryRequiresComputeAgent: true,
        agentlessCpuNamespace: 'oci_vmi_resource_utilization',
      },
    };
  }

  private createMonitoringClient(job: CloudIngestionJobContext): OciMonitoringClient {
    const credential = getCredential(job.connection.credentials, ['METRICS_READ', 'OPERATIONAL']);
    if (credential === undefined) {
      throw new Error('OCI METRICS_READ or OPERATIONAL credential is required');
    }

    const regionId = optionalString(credential.payload['region']) ?? job.connection.defaultRegion ?? 'sa-bogota-1';
    const region = oci.common.Region.fromRegionId(regionId);
    const provider = new oci.common.SimpleAuthenticationDetailsProvider(
      requireString(credential.payload['tenancyId'], 'OCI tenancyId'),
      requireString(credential.payload['userId'], 'OCI userId'),
      requireString(credential.payload['fingerprint'], 'OCI fingerprint'),
      requireString(credential.payload['privateKey'], 'OCI privateKey'),
      optionalString(credential.payload['passphrase']) ?? null,
      region,
    );

    const client = new oci.monitoring.MonitoringClient({
      authenticationDetailsProvider: provider,
    });

    return client as unknown as OciMonitoringClient;
  }

  private readMetricDefinitions(job: CloudIngestionJobContext): readonly OciMetricDefinition[] {
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

  private emptyResult(
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
}
