import { describe, expect, test } from 'vitest';
import { TechnicalMetricsService } from './TechnicalMetricsService.js';
import type {
  CloudResourceItem,
  IResourceMetricRepository,
  ResourceMetricSampleItem,
} from '../../domain/interfaces/IResourceMetricRepository.js';

class FakeResourceMetricRepository implements IResourceMetricRepository {
  public resourcesQuery: { tenantId: string; limit: number } | null = null;
  public samplesQuery: { tenantId: string; limit: number } | null = null;
  public resources: readonly CloudResourceItem[] = [
    {
      id: 'res-1',
      provider: 'AWS',
      externalResourceId: 'i-0abc',
      name: 'web-prod-01',
      resourceType: 'ec2:instance',
      serviceName: 'Amazon EC2',
      regionId: 'us-east-1',
      status: 'ACTIVE',
      firstSeenAt: new Date('2026-04-01T00:00:00.000Z'),
      lastSeenAt: new Date('2026-04-30T00:00:00.000Z'),
    },
  ];
  public samples: readonly ResourceMetricSampleItem[] = [
    {
      id: 'sample-1',
      externalResourceId: 'i-0abc',
      metricName: 'cpu_utilization',
      metricUnit: 'Percent',
      value: 37.5,
      sampledAt: new Date('2026-04-30T00:00:00.000Z'),
      granularitySeconds: 1800,
    },
  ];

  public async listResourcesForTenant(
    tenantId: string,
    limit: number,
  ): Promise<readonly CloudResourceItem[]> {
    this.resourcesQuery = { tenantId, limit };
    return this.resources;
  }

  public async listMetricSamplesForTenant(
    tenantId: string,
    limit: number,
  ): Promise<readonly ResourceMetricSampleItem[]> {
    this.samplesQuery = { tenantId, limit };
    return this.samples;
  }
}

describe('TechnicalMetricsService', () => {
  test('lists cloud resources scoped to the tenant with the default limit', async () => {
    const repository = new FakeResourceMetricRepository();
    const service = new TechnicalMetricsService(repository);

    const resources = await service.listResources('tenant-1');

    expect(resources).toHaveLength(1);
    expect(resources[0]?.externalResourceId).toBe('i-0abc');
    expect(repository.resourcesQuery).toEqual({ tenantId: 'tenant-1', limit: 50 });
  });

  test('clamps an out-of-range sample limit to the allowed maximum', async () => {
    const repository = new FakeResourceMetricRepository();
    const service = new TechnicalMetricsService(repository);

    await service.listMetricSamples('tenant-1', 9999);

    expect(repository.samplesQuery).toEqual({ tenantId: 'tenant-1', limit: 200 });
  });

  test('returns metric samples scoped to the tenant', async () => {
    const repository = new FakeResourceMetricRepository();
    const service = new TechnicalMetricsService(repository);

    const samples = await service.listMetricSamples('tenant-1', 25);

    expect(samples[0]?.metricName).toBe('cpu_utilization');
    expect(repository.samplesQuery).toEqual({ tenantId: 'tenant-1', limit: 25 });
  });

  test('returns an empty list when there are no resources', async () => {
    const repository = new FakeResourceMetricRepository();
    repository.resources = [];
    const service = new TechnicalMetricsService(repository);

    expect(await service.listResources('tenant-1')).toEqual([]);
  });
});
