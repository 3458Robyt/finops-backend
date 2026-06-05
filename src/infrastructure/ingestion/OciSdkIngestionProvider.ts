import * as oci from 'oci-sdk';
import { Readable } from 'node:stream';
import type {
  CloudIngestionJobContext,
  CloudIngestionProvider,
  CloudIngestionResult,
  NormalizedFocusCostLineItem,
  NormalizedResourceMetricSample,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import { decodeMaybeGzip, parseFocusCsvToLineItems } from './focusCsvIngestion.js';
import { getCredential, optionalString, readObjectArray, readStringArray, requireString } from './providerConfig.js';

interface OciMetricDefinition {
  readonly compartmentId: string;
  readonly namespace: string;
  readonly metricName: string;
  readonly resourceId: string;
  readonly query?: string;
  readonly unit?: string;
}

interface OciFocusReportObject {
  readonly namespaceName: string;
  readonly bucketName: string;
  readonly objectName: string;
  readonly focusVersion: string;
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

interface OciObjectStorageClient {
  getObject(request: unknown): Promise<{
    readonly getObjectBody?: unknown;
  }>;
}

export class OciSdkIngestionProvider implements CloudIngestionProvider {
  public readonly providerCode = 'oci';

  public async collect(job: CloudIngestionJobContext): Promise<CloudIngestionResult> {
    if (job.sourceType === 'BILLING_EXPORT') {
      return this.collectBillingExport(job);
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

  private async collectBillingExport(job: CloudIngestionJobContext): Promise<CloudIngestionResult> {
    const objects = this.readFocusObjects(job);
    if (objects.length === 0) {
      return this.emptyResult(0, [
        'No OCI FOCUS report objects configured in cloud connection metadata key ociFocusReportObjects.',
      ], {
        costSource: 'OCI Cost Reports FOCUS',
        expectedRefreshHours: 6,
        objectsConfigured: 0,
      });
    }

    const client = this.createObjectStorageClient(job);
    const focusRows: NormalizedFocusCostLineItem[] = [];
    let apiCallCount = 0;

    for (const object of objects) {
      apiCallCount += 1;
      const response = await client.getObject({
        namespaceName: object.namespaceName,
        bucketName: object.bucketName,
        objectName: object.objectName,
      });
      const bytes = await this.bodyToBytes(response.getObjectBody);
      const csvText = decodeMaybeGzip(bytes, object.objectName);
      focusRows.push(...parseFocusCsvToLineItems({
        tenantId: job.tenantId,
        cloudConnectionId: job.cloudConnectionId,
        provider: 'OCI',
        focusVersion: object.focusVersion,
        csvText,
      }));
    }

    return {
      apiCallCount,
      objectsProcessed: objects.length,
      focusRows,
      resources: [],
      metricSamples: [],
      warnings: focusRows.length === 0 ? ['OCI FOCUS objects were read but no valid rows were parsed.'] : [],
      coverage: {
        costSource: 'OCI Cost Reports FOCUS',
        expectedRefreshHours: 6,
        objectsConfigured: objects.length,
        rowsParsed: focusRows.length,
      },
    };
  }

  private createMonitoringClient(job: CloudIngestionJobContext): OciMonitoringClient {
    const provider = this.createAuthProvider(job);
    const client = new oci.monitoring.MonitoringClient({
      authenticationDetailsProvider: provider,
    });

    return client as unknown as OciMonitoringClient;
  }

  private createObjectStorageClient(job: CloudIngestionJobContext): OciObjectStorageClient {
    const provider = this.createAuthProvider(job);
    const client = new oci.objectstorage.ObjectStorageClient({
      authenticationDetailsProvider: provider,
    });

    return client as unknown as OciObjectStorageClient;
  }

  private createAuthProvider(job: CloudIngestionJobContext): oci.common.AuthenticationDetailsProvider {
    const credential = getCredential(job.connection.credentials, [
      'METRICS_READ',
      'BILLING_EXPORT_READ',
      'STORAGE_READ',
      'OPERATIONAL',
    ]);
    if (credential === undefined) {
      throw new Error('OCI METRICS_READ, BILLING_EXPORT_READ, STORAGE_READ or OPERATIONAL credential is required');
    }

    const regionId = optionalString(credential.payload['region']) ?? job.connection.defaultRegion ?? 'sa-bogota-1';
    const region = oci.common.Region.fromRegionId(regionId);
    return new oci.common.SimpleAuthenticationDetailsProvider(
      requireString(credential.payload['tenancyId'], 'OCI tenancyId'),
      requireString(credential.payload['userId'], 'OCI userId'),
      requireString(credential.payload['fingerprint'], 'OCI fingerprint'),
      requireString(credential.payload['privateKey'], 'OCI privateKey'),
      optionalString(credential.payload['passphrase']) ?? null,
      region,
    );
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

  private readFocusObjects(job: CloudIngestionJobContext): readonly OciFocusReportObject[] {
    return readObjectArray(job.connection.metadata, 'ociFocusReportObjects').map((item) => ({
      namespaceName: requireString(item['namespaceName'], 'ociFocusReportObjects.namespaceName'),
      bucketName: requireString(item['bucketName'], 'ociFocusReportObjects.bucketName'),
      objectName: requireString(item['objectName'], 'ociFocusReportObjects.objectName'),
      focusVersion: optionalString(item['focusVersion']) ?? '1.0',
    }));
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

  private async bodyToBytes(body: unknown): Promise<Uint8Array> {
    if (body instanceof Uint8Array) {
      return body;
    }

    if (body instanceof Readable) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      return Buffer.concat(chunks);
    }

    if (typeof body === 'string') {
      return Buffer.from(body, 'utf8');
    }

    throw new Error('Unsupported OCI Object Storage body type');
  }
}
