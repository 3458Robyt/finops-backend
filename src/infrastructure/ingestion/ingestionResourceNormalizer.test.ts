import { describe, expect, test } from 'vitest';
import type {
  NormalizedCloudResource,
  NormalizedResourceMetricSample,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import {
  buildMetricDerivedResources,
  mergeNormalizedResources,
} from './ingestionResourceNormalizer.js';

describe('ingestionResourceNormalizer', () => {
  test('builds one resource per normalized metric resource id with evidence metadata', () => {
    const resources = buildMetricDerivedResources({
      tenantId: 'tenant-1',
      cloudConnectionId: 'connection-1',
      defaultRegion: 'us-ashburn-1',
    }, [
      metricSample('  ocid1.instance.demo  ', 'CpuUtilization', { namespace: 'oci_computeagent' }),
      metricSample('ocid1.instance.demo', 'MemoryUtilization', { namespace: 'oci_computeagent', resourceName: 'api-1' }),
      metricSample('', 'CpuUtilization', { namespace: 'oci_computeagent' }),
    ]);

    expect(resources).toEqual([expect.objectContaining({
      tenantId: 'tenant-1',
      cloudConnectionId: 'connection-1',
      externalResourceId: 'ocid1.instance.demo',
      name: 'ocid1.instance.demo',
      resourceType: 'COMPUTE_INSTANCE',
      serviceName: 'Oracle Compute',
      regionId: 'us-ashburn-1',
      rawResource: {
        source: 'METRIC_DERIVED',
        metricNames: ['CpuUtilization', 'MemoryUtilization'],
        sampleCount: 2,
      },
    })]);
  });

  test('prefers provider inventory over metric-derived resources', () => {
    const derived = resource({ source: 'METRIC_DERIVED' }, 'metric-name');
    const inventory = resource({ source: 'OCI_INVENTORY' }, 'inventory-name');

    expect(mergeNormalizedResources([derived, inventory])).toEqual([inventory]);
    expect(mergeNormalizedResources([inventory, derived])).toEqual([inventory]);
  });

  test('uses the provider regionId before the legacy region field', () => {
    const [resource] = buildMetricDerivedResources({
      tenantId: 'tenant-1',
      cloudConnectionId: 'connection-1',
      defaultRegion: 'us-ashburn-1',
    }, [metricSample('ocid1.instance.demo', 'CpuUtilization', {
      namespace: 'oci_computeagent',
      regionId: 'us-phoenix-1',
      region: 'legacy-wrong-region',
    })]);

    expect(resource?.regionId).toBe('us-phoenix-1');
  });
});

function metricSample(
  externalResourceId: string,
  metricName: string,
  rawMetric: Readonly<Record<string, unknown>>,
): NormalizedResourceMetricSample {
  return {
    tenantId: 'provider-tenant',
    cloudConnectionId: 'provider-connection',
    provider: 'OCI',
    externalResourceId,
    metricName,
    value: 50,
    sampledAt: new Date('2026-08-11T00:00:00Z'),
    granularitySeconds: 300,
    rawMetric,
  };
}

function resource(rawResource: Readonly<Record<string, unknown>>, name: string): NormalizedCloudResource {
  return {
    tenantId: 'tenant-1',
    cloudConnectionId: 'connection-1',
    provider: 'OCI',
    externalResourceId: 'ocid1.instance.demo',
    name,
    resourceType: 'COMPUTE_INSTANCE',
    serviceName: 'Oracle Compute',
    status: 'ACTIVE',
    rawResource,
  };
}
