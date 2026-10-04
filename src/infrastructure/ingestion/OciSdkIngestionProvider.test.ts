import { describe, expect, it, vi } from 'vitest';
import type {
  CloudIngestionJobContext,
  CloudIngestionResult,
  NormalizedFocusCostLineItem,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import { FOCUS_1_0_MANDATORY_COLUMNS } from './focusSchemaValidation.js';
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

it('validates the OCI-managed FOCUS location in the tenancy home region', async () => {
const provider = new OciSdkIngestionProvider();
let storageRegion: unknown;
let storageRequest: unknown;
Object.assign(provider as unknown as Record<string, unknown>, {
createAuthProvider: () => ({}),
createIdentityClient: () => ({
listRegionSubscriptions: async () => ({ items: [
{ regionName: 'sa-bogota-1', status: 'READY', isHomeRegion: false },
{ regionName: 'us-phoenix-1', status: 'READY', isHomeRegion: true },
] }),
close: vi.fn(),
}),
createObjectStorageClient: (job: CloudIngestionJobContext) => {
storageRegion = job.requestContext?.['regionId'];
return {
listObjects: async (request: unknown) => { storageRequest = request; return { listObjects: { objects: [] } }; },
close: vi.fn(),
};
},
});

const baseJob = buildOciFocusJob();
const job = {
...baseJob,
requestContext: { regionId: 'sa-bogota-1' },
connection: { ...baseJob.connection, defaultRegion: 'sa-bogota-1', metadata: {} },
};
const result = await (provider as unknown as {
validateStorageCapability: (
connection: CloudIngestionJobContext['connection'],
job: CloudIngestionJobContext,
checkedAt: Date,
  ) => Promise<{ status: string; message: string; metadata?: Record<string, unknown> }>;
}).validateStorageCapability(
job.connection,
job,
new Date(),
);

expect(result.status).toBe('AVAILABLE');
expect(storageRegion).toBe('us-phoenix-1');
expect(storageRequest).toMatchObject({
namespaceName: 'bling',
bucketName: 'ocid1.tenancy.oc1.test',
prefix: 'FOCUS Reports/',
limit: 1,
});
expect(result.metadata).toMatchObject({ autoDetected: true, regionId: 'us-phoenix-1' });
});

it('does not fall back to the configured region when OCI omits the home-region marker', async () => {
const provider = new OciSdkIngestionProvider();
const createStorageClient = vi.fn();
Object.assign(provider as unknown as Record<string, unknown>, {
createAuthProvider: () => ({}),
createIdentityClient: () => ({
listRegionSubscriptions: async () => ({ items: [{ regionName: 'sa-bogota-1', status: 'READY', isHomeRegion: false }] }),
close: vi.fn(),
}),
createObjectStorageClient: createStorageClient,
});
const job = {
...buildOciFocusJob(),
requestContext: { regionId: 'sa-bogota-1' },
connection: { ...buildOciFocusJob().connection, defaultRegion: 'sa-bogota-1', metadata: {} },
};
const result = await (provider as unknown as {
validateStorageCapability: (
connection: CloudIngestionJobContext['connection'],
job: CloudIngestionJobContext,
checkedAt: Date,
) => Promise<{ status: string; message: string }>;
}).validateStorageCapability(job.connection, job, new Date());

expect(result.status).toBe('ERROR');
expect(result.message).toContain('región principal');
expect(createStorageClient).not.toHaveBeenCalled();
});

it('collects compute inventory resources through the OCI SDK', async () => {
const provider = new OciSdkIngestionProvider();
Object.assign(provider as unknown as { createComputeClient: () => unknown }, {
createAuthProvider: () => ({}),
createIdentityClient: () => ({
listRegionSubscriptions: async () => ({ items: [{ regionName: 'sa-bogota-1', status: 'READY' }] }),
close: () => undefined,
}),
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
expect(result.coverage).toMatchObject({
inventorySource: 'oci_compute_sdk_with_metadata_fallback',
inventoryCompartmentDiscovery: 'CONFIGURED_ONLY',
configuredCompartmentCount: 1,
mergedResourceCount: 1,
});
});

it('discovers active OCI compartments recursively before listing instances', async () => {
const provider = new OciSdkIngestionProvider();
const listedCompartments: string[] = [];
const listedInstances: string[] = [];
Object.assign(provider as unknown as Record<string, unknown>, {
createAuthProvider: () => ({}),
createIdentityClient: () => ({
listRegionSubscriptions: async () => ({ items: [{ regionName: 'sa-bogota-1', status: 'READY' }] }),
listCompartments: async (request: { readonly page?: string }) => {
listedCompartments.push(request.page ?? 'root');
return request.page === undefined
? { items: [{ id: 'compartment-a', lifecycleState: 'ACTIVE' }], opcNextPage: 'page-2' }
: { items: [{ id: 'compartment-b', lifecycleState: 'ACTIVE' }] };
},
close: () => undefined,
}),
createComputeClient: () => ({
listInstances: async (request: { readonly compartmentId: string }) => {
listedInstances.push(request.compartmentId);
return { items: [{ id: `instance-${request.compartmentId}`, lifecycleState: 'RUNNING' }] };
},
close: () => undefined,
}),
});

const result = await provider.collect({
...buildMetricJob(),
sourceType: 'INVENTORY',
connection: {
...buildMetricJob().connection,
metadata: {},
credentials: [{ purpose: 'INVENTORY_READ', payload: {} }],
},
});

expect(listedCompartments).toEqual(['root', 'page-2']);
expect(listedInstances).toEqual(['ocid1.tenancy.oc1.test', 'compartment-a', 'compartment-b']);
expect(result.resources).toHaveLength(3);
expect(result.coverage).toMatchObject({
inventoryCompartmentDiscovery: 'COMPLETE',
discoveredCompartmentCount: 2,
compartmentCount: 3,
});
});

  it('normalizes metric samples from OCI TypeScript SDK items response', async () => {
    // El proveedor OCI solo conserva 90 días; fija el reloj para que la
    // fixture histórica no empiece a fallar cuando avance la fecha real.
    vi.useFakeTimers({ now: new Date('2026-06-04T02:00:00Z') });
    try {
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
    const samples = [...result.metricSamples];
    if (result.metricBatches !== undefined) {
      for await (const batch of result.metricBatches) samples.push(...batch);
    }

    expect(requests).toHaveLength(1);
    expect(samples).toEqual([
      expect.objectContaining({
        provider: 'OCI',
        externalResourceId: 'ocid1.instance.oc1.test',
        metricName: 'CpuUtilization',
        value: 4.2,
        granularitySeconds: 1800,
      }),
    ]);
    expect(result.warnings).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
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
      focusSchemaValidation: { status: 'CONFORMANT', filesChecked: 1, filesConformant: 1 },
    });
    expect(result.warnings).toEqual([]);
  });

  it('continues past old FOCUS pages until it finds objects in the billing window', async () => {
    const provider = new OciSdkIngestionProvider();
    const listRequests: unknown[] = [];
    let getObjectCalls = 0;

    Object.assign(provider as unknown as { createObjectStorageClient: () => unknown }, {
      createObjectStorageClient: () => ({
        listObjects: async (request: unknown) => {
          listRequests.push(request);
          const start = request && typeof request === 'object' && 'start' in request
            ? (request as { start?: string }).start
            : undefined;
          if (start === undefined) {
            return {
              listObjects: {
                objects: [{ name: 'reports/focus/2024/06/04/old-report.csv.gz' }],
                nextStartWith: 'page-2',
              },
            };
          }

          return {
            listObjects: {
              objects: [{ name: 'reports/focus/2026/06/04/current-report.csv' }],
            },
          };
        },
        getObject: async () => {
          getObjectCalls += 1;
          return { getObjectBody: Buffer.from(buildFocusCsv(), 'utf8') };
        },
      }),
    });

    const result = await provider.collect(buildOciFocusJob());
    const focusRows = await collectFocusRows(result.focusBatches);

    expect(listRequests).toHaveLength(2);
    expect(getObjectCalls).toBe(1);
    expect(result.objectsProcessed).toBe(1);
    expect(focusRows).toHaveLength(1);
    expect(focusRows[0]?.resourceId).toBe('ocid1.instance.oc1.test');
  });

  it('reads OCI FOCUS object metadata written with OCI CLI field names', async () => {
    const provider = new OciSdkIngestionProvider();
    let listObjectCalls = 0;

    Object.assign(provider as unknown as { createObjectStorageClient: () => unknown }, {
      createObjectStorageClient: () => ({
        listObjects: async () => {
          listObjectCalls += 1;
          return { listObjects: { objects: [] } };
        },
        getObject: async () => ({ getObjectBody: Buffer.from(buildFocusCsv(), 'utf8') }),
      }),
    });

    const job = buildOciFocusJob();
    const result = await provider.collect({
      ...job,
      connection: {
        ...job.connection,
        metadata: {
          ociFocusReportObjects: [{
            'namespace-name': 'tenantnamespace',
            'bucket-name': 'finops-billing',
            'object-name': 'reports/focus/2026/06/04/current-report.csv',
            'focus-version': '1.0',
          }],
        },
      },
    });
    const focusRows = await collectFocusRows(result.focusBatches);

    expect(listObjectCalls).toBe(0);
    expect(focusRows).toHaveLength(1);
    expect(result.coverage).toMatchObject({ objectsConfigured: 1 });
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

  it('does not persist FOCUS rows outside the requested billing window', async () => {
    const provider = new OciSdkIngestionProvider();

    Object.assign(provider as unknown as { createObjectStorageClient: () => unknown }, {
      createObjectStorageClient: () => ({
        listObjects: async () => ({
          listObjects: { objects: [{ name: 'reports/focus/2026/06/04/report.csv' }] },
        }),
        getObject: async () => ({ getObjectBody: Buffer.from(buildFocusCsv(), 'utf8') }),
      }),
      createUsageClient: () => ({
        requestSummarizedUsages: async () => ({ usageAggregation: { items: [] } }),
        close: () => undefined,
      }),
    });

    const result = await provider.collect({
      ...buildOciFocusJob(),
      targetStart: new Date('2026-06-05T00:00:00Z'),
      targetEnd: new Date('2026-06-06T00:00:00Z'),
    });
    const focusRows = await collectFocusRows(result.focusBatches);

    expect(focusRows).toHaveLength(0);
    expect(result.objectsProcessed).toBe(0);
    expect(result.warnings[0]).toContain('No se encontraron objetos de reporte FOCUS OCI');
  });

  it('normalizes OCI Usage API costs through the billing collector', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-22T12:00:00Z') });
    try {
    const provider = new OciSdkIngestionProvider();
    const requests: unknown[] = [];
    let closed = false;

    Object.assign(provider as unknown as Record<string, unknown>, {
      createUsageClient: () => ({
        requestSummarizedUsages: async (request: unknown) => {
          requests.push(request);
          return {
            usageAggregation: {
              items: [{
                service: 'Compute',
                computedAmount: 12.5,
                computedQuantity: 4,
                currency: 'USD',
                resourceId: 'ocid1.instance.oc1.test',
                region: 'sa-bogota-1',
              }],
            },
          };
        },
        close: () => { closed = true; },
      }),
    });

    const result = await provider.collect({
      ...buildOciFocusJob(),
      connection: {
        ...buildOciFocusJob().connection,
        metadata: { billingSourceMode: 'PROVIDER_API' },
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requestSummarizedUsagesDetails: {
        timeUsageStarted: new Date('2026-06-04T00:00:00.000Z'),
        timeUsageEnded: new Date('2026-06-05T00:00:00.000Z'),
        granularity: 'DAILY',
      },
    });
    expect(result.providerCostRows).toEqual([
      expect.objectContaining({
        provider: 'OCI',
        serviceName: 'Compute',
        billedCost: 12.5,
        consumedQuantity: 4,
        billingCurrency: 'USD',
        resourceId: 'ocid1.instance.oc1.test',
        chargePeriodStart: new Date('2026-06-04T00:00:00.000Z'),
        chargePeriodEnd: new Date('2026-06-05T00:00:00.000Z'),
      }),
    ]);
    expect(result.coverage).toMatchObject({
      billingSource: 'PROVIDER_API',
      costSource: 'OCI Usage API',
      rows: 1,
    });
    expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to OCI Usage API when AUTO cannot find a managed FOCUS object', async () => {
    const provider = new OciSdkIngestionProvider();
    Object.assign(provider as unknown as Record<string, unknown>, {
      createAuthProvider: () => ({}),
      createIdentityClient: () => ({
        listRegionSubscriptions: async () => ({ items: [{
          regionName: 'us-phoenix-1', status: 'READY', isHomeRegion: true,
        }] }),
        close: () => undefined,
      }),
      createObjectStorageClient: () => ({
        listObjects: async () => ({ listObjects: { objects: [] } }),
        close: () => undefined,
      }),
      createUsageClient: () => ({
        requestSummarizedUsages: async () => ({
          usageAggregation: {
            items: [{ service: 'Compute', computedAmount: 3.5, currency: 'USD', resourceId: 'instance-1' }],
          },
        }),
        close: () => undefined,
      }),
    });

    const result = await provider.collect({
      ...buildOciFocusJob(),
      connection: { ...buildOciFocusJob().connection, metadata: {} },
    });

    expect(result.providerCostRows).toHaveLength(1);
    expect(result.dataOutcome).toBe('DATA_WRITTEN');
    expect(result.coverage).toMatchObject({
      billingSource: 'PROVIDER_API',
      billingSourceFallback: 'FOCUS_TO_PROVIDER_API',
    });
    expect(result.warnings[0]).toContain('No se encontraron objetos de reporte FOCUS OCI');
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
  const values: Readonly<Record<string, string>> = {
    BilledCost: '8.75',
    BillingAccountId: 'tenancy-1',
    BillingAccountName: 'Test tenancy',
    BillingCurrency: 'USD',
    BillingPeriodEnd: '2026-07-01 00:00:00',
    BillingPeriodStart: '2026-06-01 00:00:00',
    ChargeCategory: 'Usage',
    ChargeClass: 'Usage',
    ChargePeriodEnd: '2026-06-04 02:00:00',
    ChargePeriodStart: '2026-06-04 01:30:00',
    ContractedCost: '8.75',
    ConsumedQuantity: '2',
    ConsumedUnit: 'Hours',
    EffectiveCost: '8',
    InvoiceIssuer: 'Oracle Cloud Infrastructure',
    ListCost: '9',
    PricingUnit: 'Hours',
    Provider: 'Oracle Cloud Infrastructure',
    ProviderName: 'Oracle Cloud Infrastructure',
    Publisher: 'Oracle',
    RegionId: 'sa-bogota-1',
    ResourceId: 'ocid1.instance.oc1.test',
    ServiceCategory: 'Compute',
    ServiceName: 'Compute',
    SubAccountId: 'compartment-1',
  };
  return [
    [...FOCUS_1_0_MANDATORY_COLUMNS, 'ConsumedQuantity', 'ConsumedUnit', 'ListCost', 'ProviderName', 'RegionId', 'ResourceId', 'SubAccountId'].join(','),
    [...FOCUS_1_0_MANDATORY_COLUMNS, 'ConsumedQuantity', 'ConsumedUnit', 'ListCost', 'ProviderName', 'RegionId', 'ResourceId', 'SubAccountId'].map((header) => values[header] ?? '').join(','),
  ].join('\n');
}
