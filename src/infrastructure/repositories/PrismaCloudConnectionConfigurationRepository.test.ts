import { describe, expect, test, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { hashOciMetricDimensions } from '../ingestion/oci/OciMetricDimensions.js';
import { mergeEnabledMetricDefinitions } from '../ingestion/ingestionMetricDefinitionMetadata.js';
import { PrismaCloudConnectionConfigurationRepository } from './PrismaCloudConnectionConfigurationRepository.js';

test('OCI dimensions hashing preserves the empty-dimensions hash used by metric samples', () => {
  expect(hashOciMetricDimensions(undefined)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  expect(hashOciMetricDimensions({})).toBe(hashOciMetricDimensions(undefined));
});

describe('PrismaCloudConnectionConfigurationRepository OCI metric definitions', () => {
  test('persists selected series to normalized catalog with dimensions and matching sample hash', async () => {
    const { repository, transaction } = buildRepository();
    const dimensions = { availabilityDomain: 'AD-1', resourceId: 'ocid1.instance.oc1..exampleid0013' };
    await repository.configureMetricDefinitionsForConnection({
      tenantId: 'tenant-1', cloudConnectionId: 'connection-1', replace: false,
      definitions: [{
        compartmentId: 'compartment-1', namespace: 'oci_computeagent', metricName: 'CpuUtilization',
        resourceId: dimensions.resourceId, regionId: 'us-phoenix-1', dimensions, statistics: ['MEAN', 'MAX'], unit: 'Percent',
      }],
    });

    expect(transaction.cloudConnection.update).toHaveBeenCalled();
    expect(transaction.cloudMetricDefinition.updateMany).not.toHaveBeenCalled();
    expect(transaction.cloudMetricDefinition.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { cloudConnectionId_namespace_metricName_compartmentId_externalResourceId_dimensionsHash: {
        cloudConnectionId: 'connection-1', namespace: 'oci_computeagent', metricName: 'CpuUtilization',
        compartmentId: 'compartment-1', externalResourceId: dimensions.resourceId,
        dimensionsHash: hashOciMetricDimensions(dimensions),
      } },
      create: expect.objectContaining({
        tenantId: 'tenant-1', regionId: 'us-phoenix-1', dimensions, statistics: ['MEAN', 'MAX'],
        enabled: true, status: 'CONFIRMED', discoverySource: 'OCI_LIST_METRICS',
      }),
    }));
  });

  test('disables prior catalog entries when replacing configured definitions', async () => {
    const { repository, transaction } = buildRepository();
    await repository.configureMetricDefinitionsForConnection({
      tenantId: 'tenant-1', cloudConnectionId: 'connection-1', replace: true,
      definitions: [{ compartmentId: 'compartment-1', namespace: 'oci_computeagent', metricName: 'CpuUtilization', resourceId: 'instance-1', statistics: ['MEAN'] }],
    });

    expect(transaction.cloudMetricDefinition.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', cloudConnectionId: 'connection-1' },
      data: { enabled: false, status: 'DISCOVERED' },
    });
    expect(transaction.cloudMetricDefinition.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(transaction.cloudMetricDefinition.upsert.mock.invocationCallOrder[0]!);
  });
});

test('normalized OCI definitions retain custom MQL queries from legacy metadata', () => {
  const query = 'CpuUtilization[30m]{resourceId = "instance-1"}.mean()';
  const result = mergeEnabledMetricDefinitions({ ociMetricDefinitions: [{
    compartmentId: 'compartment-1', namespace: 'oci_computeagent', metricName: 'CpuUtilization',
    resourceId: 'instance-1', statistics: ['MEAN'], query,
  }] }, [{
    compartmentId: 'compartment-1', namespace: 'oci_computeagent', metricName: 'CpuUtilization',
    externalResourceId: 'instance-1', regionId: null, dimensions: null, metricUnit: null, statistics: ['MEAN'],
  }]);

  expect(result?.['ociMetricDefinitions']).toEqual([expect.objectContaining({ query })]);
});

function buildRepository() {
  const transaction = {
    cloudConnection: {
      findFirst: vi.fn(async () => ({
        id: 'connection-1', providerCode: 'oci', metadata: {}, defaultRegion: 'us-phoenix-1',
      })),
      update: vi.fn(async () => ({})),
    },
    cloudMetricDefinition: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(async () => ({})),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)),
  } as unknown as PrismaClient;
  return { repository: new PrismaCloudConnectionConfigurationRepository(prisma), transaction };
}
