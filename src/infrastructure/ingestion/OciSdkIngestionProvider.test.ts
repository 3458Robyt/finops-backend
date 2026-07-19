import { describe, expect, it } from 'vitest';
import type {
  CloudIngestionJobContext,
  CloudIngestionResult,
  NormalizedFocusCostLineItem,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import { OciSdkIngestionProvider } from './OciSdkIngestionProvider.js';

describe('OciSdkIngestionProvider', () => {
it('reports every capability as not configured without exposing credentials', async () => {
const result = await new OciSdkIngestionProvider().validate({
id: 'connection_1', tenantId: 'tenant_1', providerCode: 'oci',
rootExternalId: 'ocid1.tenancy.oc1.test', defaultRegion: 'sa-bogota-1', credentials: [],
});

expect(result.capabilities).toHaveLength(5);
expect(result.capabilities.every((item) => item.status === 'NOT_CONFIGURED')).toBe(true);
expect(JSON.stringify(result)).not.toMatch(/privateKey|passphrase|fingerprint/i);
});

it('collects compute inventory resources through the OCI SDK', async () => {
const provider = new OciSdkIngestionProvider();
Object.assign(provider as unknown as { createComputeClient: () => unknown }, {
createComputeClient: () => ({
listInstances: async () => ({
items: [
{
id: 'ocid1.instance.oc1.test',
displayName: 'api-prod',
lifecycleState: 'RUNNING',
shape: 'VM.Standard.E4.Flex',
freeformTags: { environment: 'prod' },
},
],
}),
}),
});

const result = await provider.collect({
...buildMetricJob(),
sourceType: 'INVENTORY',
});

expect(result.resources).toEqual([
expect.objectContaining({
provider: 'OCI',
externalResourceId: 'ocid1.instance.oc1.test',
name: 'api-prod',
resourceType: 'COMPUTE_INSTANCE',
serviceName: 'Oracle Compute',
status: 'ACTIVE',
}),
]);
expect(result.coverage).toMatchObject({ inventorySource: 'oci_compute_sdk_with_metadata_fallback' });
});

it('normalizes metric samples from OCI TypeScript SDK items response', async () => {
    const provider = new OciSdkIngestionProvider();
    const requests: unknown[] = [];

    Object.assign(provider as unknown as { createMonitoringClient: () => unknown }, {
      createMonitoringClient: () => ({
        summarizeMetricsData: async (request: unknown) => {
          requests.push(request);
          return {
            items: [
              {
                namespace: 'oci_computeagent',
                name: 'CpuUtilization',
                dimensions: { resourceId: 'ocid1.instance.oc1.test' },
                aggregatedDatapoints: [
                  { timestamp: new Date('2026-06-04T01:30:00Z'), value: 4.2 },
                ],
              },
            ],
          };
        },
      }),
    });

    const result = await provider.collect(buildMetricJob());

    expect(requests).toHaveLength(1);
    expect(result.metricSamples).toEqual([
      expect.objectContaining({
        provider: 'OCI',
        externalResourceId: 'ocid1.instance.oc1.test',
        metricName: 'CpuUtilization',
        value: 4.2,
        granularitySeconds: 1800,
      }),
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('discovers and parses OCI FOCUS reports from Object Storage prefixes', async () => {
    const provider = new OciSdkIngestionProvider();
    const calls: string[] = [];

    Object.assign(provider as unknown as { createObjectStorageClient: () => unknown }, {
      createObjectStorageClient: () => ({
        listObjects: async () => {
          calls.push('listObjects');
          return {
            listObjects: {
              objects: [
                { name: 'reports/focus/2026-06/report.csv' },
                { name: 'reports/focus/2026-06/readme.txt' },
              ],
            },
          };
        },
        getObject: async () => {
          calls.push('getObject');
          return {
            getObjectBody: Buffer.from(buildFocusCsv(), 'utf8'),
          };
        },
      }),
    });

    const result = await provider.collect(buildOciFocusJob());
    const focusRows = await collectFocusRows(result.focusBatches);

    expect(calls).toEqual(['listObjects', 'getObject']);
    expect(result.objectsProcessed).toBe(1);
    expect(result.focusRows).toHaveLength(0);
    expect(focusRows).toHaveLength(1);
    expect(focusRows[0]).toMatchObject({
      provider: 'OCI',
      serviceName: 'Compute',
      resourceId: 'ocid1.instance.oc1.test',
      billedCost: 8.75,
      consumedQuantity: 2,
      consumedUnit: 'Hours',
    });
    expect(result.coverage).toMatchObject({
      objectsDiscovered: 1,
      rowsParsed: 'streamed',
    });
    expect(result.warnings).toEqual([]);
  });

  it('parses OCI FOCUS reports when Object Storage returns an arrayBuffer body', async () => {
    const provider = new OciSdkIngestionProvider();

    Object.assign(provider as unknown as { createObjectStorageClient: () => unknown }, {
      createObjectStorageClient: () => ({
        listObjects: async () => ({
          listObjects: {
            objects: [
              { name: 'reports/focus/2026-06/report.csv' },
            ],
          },
        }),
        getObject: async () => {
          const bytes = Buffer.from(buildFocusCsv(), 'utf8');
          return {
            getObjectBody: {
              arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            },
          };
        },
      }),
    });

    const result = await provider.collect(buildOciFocusJob());
    const focusRows = await collectFocusRows(result.focusBatches);

    expect(result.objectsProcessed).toBe(1);
    expect(focusRows).toHaveLength(1);
    expect(focusRows[0]?.provider).toBe('OCI');
  });

  it('parses OCI FOCUS reports when Object Storage returns a value ReadableStream', async () => {
    const provider = new OciSdkIngestionProvider();

    Object.assign(provider as unknown as { createObjectStorageClient: () => unknown }, {
      createObjectStorageClient: () => ({
        listObjects: async () => ({
          listObjects: {
            objects: [
              { name: 'reports/focus/2026-06/report.csv' },
            ],
          },
        }),
        getObject: async () => {
          const bytes = Buffer.from(buildFocusCsv(), 'utf8');
          return {
            value: new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
          };
        },
      }),
    });

    const result = await provider.collect(buildOciFocusJob());
    const focusRows = await collectFocusRows(result.focusBatches);

    expect(result.objectsProcessed).toBe(1);
    expect(focusRows).toHaveLength(1);
    expect(focusRows[0]?.provider).toBe('OCI');
  });
});

async function collectFocusRows(
  batches: CloudIngestionResult['focusBatches'],
): Promise<NormalizedFocusCostLineItem[]> {
  const rows: NormalizedFocusCostLineItem[] = [];
  if (batches === undefined) {
    return rows;
  }

  for await (const batch of batches) {
    rows.push(...batch);
  }

  return rows;
}

function buildMetricJob(): CloudIngestionJobContext {
  return {
    id: 'job_1',
    tenantId: 'tenant_1',
    cloudConnectionId: 'connection_1',
    sourceType: 'TECHNICAL_METRIC',
    targetStart: new Date('2026-06-04T01:30:00Z'),
    targetEnd: new Date('2026-06-04T02:00:00Z'),
    connection: {
      id: 'connection_1',
      tenantId: 'tenant_1',
      providerCode: 'oci',
      rootExternalId: 'ocid1.tenancy.oc1.test',
      credentials: [],
      metadata: {
        ociMetricDefinitions: [
          {
            compartmentId: 'ocid1.tenancy.oc1.test',
            namespace: 'oci_computeagent',
            metricName: 'CpuUtilization',
            resourceId: 'ocid1.instance.oc1.test',
          },
        ],
      },
    },
  };
}

function buildOciFocusJob(): CloudIngestionJobContext {
  return {
    id: 'job_2',
    tenantId: 'tenant_1',
    cloudConnectionId: 'connection_1',
    sourceType: 'BILLING_EXPORT',
    targetStart: new Date('2026-06-04T01:30:00Z'),
    targetEnd: new Date('2026-06-04T02:00:00Z'),
    connection: {
      id: 'connection_1',
      tenantId: 'tenant_1',
      providerCode: 'oci',
      rootExternalId: 'ocid1.tenancy.oc1.test',
      credentials: [],
      metadata: {
        ociFocusReportLocations: [
          {
            namespaceName: 'tenantnamespace',
            bucketName: 'finops-billing',
            prefix: 'reports/focus/',
            focusVersion: '1.0',
            maxObjects: 10,
          },
        ],
      },
    },
  };
}

function buildFocusCsv(): string {
  return [
    [
      'BilledCost',
      'BillingCurrency',
      'BillingAccountId',
      'ChargeCategory',
      'ChargePeriodStart',
      'ChargePeriodEnd',
      'ConsumedQuantity',
      'ConsumedUnit',
      'EffectiveCost',
      'ListCost',
      'ProviderName',
      'RegionId',
      'ResourceId',
      'ServiceName',
      'SubAccountId',
    ].join(','),
    [
      '8.75',
      'USD',
      'tenancy-1',
      'Usage',
      '2026-06-01 00:00:00',
      '2026-06-01 01:00:00',
      '2',
      'Hours',
      '8',
      '9',
      'Oracle Cloud Infrastructure',
      'sa-bogota-1',
      'ocid1.instance.oc1.test',
      'Compute',
      'compartment-1',
    ].join(','),
  ].join('\n');
}
