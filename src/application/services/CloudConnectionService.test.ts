import { describe, expect, test } from 'vitest';
import { CloudConnectionService } from './CloudConnectionService.js';
import type {
  CreateCloudConnectionInput,
  CreateIngestionJobInput,
  DataQualityCheckItem,
  ICloudConnectionRepository,
  IngestionJobHistoryItem,
  IngestionJobSummary,
} from '../../domain/interfaces/ICloudConnectionRepository.js';
import type {
  CloudConnectionSummary,
  IngestionHealthSummary,
  ProviderCatalogEntry,
} from '../../domain/models/CloudConnection.js';

const awsProvider: ProviderCatalogEntry = {
  code: 'aws',
  displayName: 'Amazon Web Services',
  provider: 'AWS',
  capabilities: ['FOCUS_EXPORT'],
  defaultFocusVersion: '1.2',
  enabled: true,
};

class FakeCloudConnectionRepository implements ICloudConnectionRepository {
  public createdConnectionInput: CreateCloudConnectionInput | null = null;
  public createdJobInput: CreateIngestionJobInput | null = null;
  public ingestionHistoryQuery: { tenantId: string; limit: number } | null = null;
  public dataQualityQuery: { tenantId: string; limit: number } | null = null;
  public ingestionHistory: readonly IngestionJobHistoryItem[] = [
    {
      id: 'job-h1',
      cloudConnectionId: 'conn-1',
      sourceType: 'BILLING_EXPORT',
      status: 'SUCCESS',
      attempts: 1,
      maxAttempts: 3,
      targetStart: new Date('2026-04-01T00:00:00.000Z'),
      targetEnd: new Date('2026-04-02T00:00:00.000Z'),
      createdAt: new Date('2026-04-02T01:00:00.000Z'),
      updatedAt: new Date('2026-04-02T01:05:00.000Z'),
    },
  ];
  public dataQualityChecks: readonly DataQualityCheckItem[] = [
    {
      id: 'dq-1',
      cloudConnectionId: 'conn-1',
      sourceType: 'BILLING_EXPORT',
      checkName: 'frescura_facturacion',
      status: 'PASSED',
      observedAt: new Date('2026-04-02T01:10:00.000Z'),
    },
  ];
  public connection: CloudConnectionSummary | null = {
    id: 'conn-1',
    tenantId: 'tenant-1',
    providerCode: 'aws',
    rootExternalId: '123456789012',
    name: 'AWS Org',
    status: 'ACTIVE',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
  };

  public async listProviderCatalog(): Promise<readonly ProviderCatalogEntry[]> {
    return [awsProvider];
  }

  public async findProviderCatalog(providerCode: string): Promise<ProviderCatalogEntry | null> {
    return providerCode === 'aws' ? awsProvider : null;
  }

  public async createCloudConnection(
    input: CreateCloudConnectionInput,
  ): Promise<CloudConnectionSummary> {
    this.createdConnectionInput = input;
    return {
      id: 'conn-created',
      tenantId: input.tenantId,
      providerCode: input.providerCode,
      rootExternalId: input.rootExternalId,
      name: input.name,
      status: 'ACTIVE',
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    };
  }

  public async findCloudConnectionForTenant(): Promise<CloudConnectionSummary | null> {
    return this.connection;
  }

  public async listCloudConnectionsForTenant(): Promise<readonly CloudConnectionSummary[]> {
    return this.connection === null ? [] : [this.connection];
  }

  public async markCloudConnectionValidated(): Promise<void> {}

  public async createIngestionJob(input: CreateIngestionJobInput): Promise<IngestionJobSummary> {
    this.createdJobInput = input;
    return {
      id: 'job-1',
      tenantId: input.tenantId,
      cloudConnectionId: input.cloudConnectionId,
      sourceType: input.sourceType,
      status: 'PENDING',
      targetStart: input.targetStart,
      targetEnd: input.targetEnd,
      attempts: 0,
      maxAttempts: 3,
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    };
  }

  public async getIngestionHealth(): Promise<IngestionHealthSummary | null> {
    return null;
  }

  public async listIngestionJobsForTenant(
    tenantId: string,
    limit: number,
  ): Promise<readonly IngestionJobHistoryItem[]> {
    this.ingestionHistoryQuery = { tenantId, limit };
    return this.ingestionHistory;
  }

  public async listDataQualityChecksForTenant(
    tenantId: string,
    limit: number,
  ): Promise<readonly DataQualityCheckItem[]> {
    this.dataQualityQuery = { tenantId, limit };
    return this.dataQualityChecks;
  }
}

describe('CloudConnectionService', () => {
  test('registers a root cloud connection against an enabled provider', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository);

    const connection = await service.registerConnection({
      tenantId: 'tenant-1',
      providerCode: 'AWS',
      rootExternalId: '123456789012',
      name: 'AWS Organization',
    });

    expect(connection.id).toBe('conn-created');
    expect(repository.createdConnectionInput).toEqual({
      tenantId: 'tenant-1',
      providerCode: 'aws',
      rootExternalId: '123456789012',
      name: 'AWS Organization',
    });
  });

  test('does not persist temporary admin credentials during provisioning', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository);

    const result = await service.provisionWithTemporaryAdmin({
      tenantId: 'tenant-1',
      cloudConnectionId: 'conn-1',
      temporaryAdminCredential: { accessKeyId: 'admin', secretAccessKey: 'secret' },
    });

    expect(result.adminCredentialStored).toBe(false);
    expect(result.status).toBe('PENDING_PROVIDER_AUTOMATION');
  });

  test('queues a billing export ingestion job for the authenticated user', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository);

    const job = await service.queueIngestion({
      tenantId: 'tenant-1',
      userId: 'user-1',
      cloudConnectionId: 'conn-1',
      sourceType: 'BILLING_EXPORT',
      targetStart: new Date('2026-04-01T00:00:00.000Z'),
      targetEnd: new Date('2026-04-02T00:00:00.000Z'),
    });

    expect(job.status).toBe('PENDING');
    expect(repository.createdJobInput).toMatchObject({
      tenantId: 'tenant-1',
      requestedByUserId: 'user-1',
      sourceType: 'BILLING_EXPORT',
    });
  });

  test('lists ingestion history scoped to the tenant with the default limit', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository);

    const jobs = await service.listIngestionHistory('tenant-1');

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe('job-h1');
    expect(repository.ingestionHistoryQuery).toEqual({ tenantId: 'tenant-1', limit: 50 });
  });

  test('clamps an out-of-range ingestion history limit to the allowed maximum', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository);

    await service.listIngestionHistory('tenant-1', 9999);

    expect(repository.ingestionHistoryQuery).toEqual({ tenantId: 'tenant-1', limit: 200 });
  });

  test('lists data quality checks scoped to the tenant', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository);

    const checks = await service.listDataQualityChecks('tenant-1', 10);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.checkName).toBe('frescura_facturacion');
    expect(repository.dataQualityQuery).toEqual({ tenantId: 'tenant-1', limit: 10 });
  });

  test('returns an empty list when there are no data quality checks', async () => {
    const repository = new FakeCloudConnectionRepository();
    repository.dataQualityChecks = [];
    const service = new CloudConnectionService(repository);

    const checks = await service.listDataQualityChecks('tenant-1');

    expect(checks).toEqual([]);
  });
});
