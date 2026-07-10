import { describe, expect, test } from 'vitest';
import { CloudConnectionService } from './CloudConnectionService.js';
import type {
  ConfigureFocusSourceForConnectionInput,
  ConfigureFocusSourceForConnectionResult,
  CreateCloudConnectionInput,
  CreateIngestionJobInput,
  DataQualityCheckItem,
  ICloudConnectionRepository,
  IngestionJobRangeQuery,
  IngestionJobWindowItem,
  IngestionReadinessSummary,
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
  public createdJobInputs: CreateIngestionJobInput[] = [];
  public configuredFocusInput: ConfigureFocusSourceForConnectionInput | null = null;
  public rangeQuery: IngestionJobRangeQuery | null = null;
  public rangeJobs: readonly IngestionJobWindowItem[] = [];
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
  public readiness: IngestionReadinessSummary = {
    ok: false,
    generatedAt: new Date('2026-06-05T12:00:00.000Z'),
    connections: [],
    issues: [
      {
        provider: 'oci',
        severity: 'BLOCKER',
        message: 'No active OCI cloud connection found for this tenant.',
      },
    ],
  };
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
    this.createdJobInputs.push(input);
    return {
      id: `job-${this.createdJobInputs.length}`,
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

  public async listIngestionReadinessForTenant(): Promise<IngestionReadinessSummary> {
    return this.readiness;
  }

  public async configureFocusSourceForConnection(
    input: ConfigureFocusSourceForConnectionInput,
  ): Promise<ConfigureFocusSourceForConnectionResult | null> {
    this.configuredFocusInput = input;
    if (this.connection === null) {
      return null;
    }

    return {
      cloudConnectionId: input.cloudConnectionId,
      providerCode: this.connection.providerCode,
      mode: input.mode,
      updatedKey: 'ociFocusReportLocations',
      configuredCount: 1,
      replaced: input.replace,
    };
  }

  public async listIngestionJobsForConnectionRange(
    input: IngestionJobRangeQuery,
  ): Promise<readonly IngestionJobWindowItem[]> {
    this.rangeQuery = input;
    return this.rangeJobs;
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

  test('returns ingestion readiness for the authenticated tenant', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository);

    const readiness = await service.getIngestionReadiness('tenant-1');

    expect(readiness.ok).toBe(false);
    expect(readiness.issues[0]).toMatchObject({
      provider: 'oci',
      severity: 'BLOCKER',
    });
  });

  test('configures a FOCUS source for a tenant connection', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository);

    const result = await service.configureFocusSource({
      tenantId: 'tenant-1',
      cloudConnectionId: 'conn-1',
      mode: 'location',
      replace: false,
      values: {
        'namespace-name': 'tenantnamespace',
        'bucket-name': 'finops-billing',
        prefix: 'reports/focus/',
      },
    });

    expect(result.updatedKey).toBe('ociFocusReportLocations');
    expect(repository.configuredFocusInput).toEqual({
      tenantId: 'tenant-1',
      cloudConnectionId: 'conn-1',
      mode: 'location',
      replace: false,
      values: {
        'namespace-name': 'tenantnamespace',
        'bucket-name': 'finops-billing',
        prefix: 'reports/focus/',
      },
    });
  });

  test('queues technical metric backfill in historical windows', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository);

    const result = await service.queueTechnicalMetricBackfill({
      tenantId: 'tenant-1',
      userId: 'user-1',
      cloudConnectionId: 'conn-1',
      lookbackDays: 2,
      windowHours: 24,
    });

    expect(result.sourceType).toBe('TECHNICAL_METRIC');
    expect(result.lookbackDays).toBe(2);
    expect(result.windowHours).toBe(24);
    expect(result.createdJobs).toHaveLength(2);
    expect(repository.createdJobInputs).toHaveLength(2);
    expect(repository.createdJobInputs[0]).toMatchObject({
      tenantId: 'tenant-1',
      cloudConnectionId: 'conn-1',
      sourceType: 'TECHNICAL_METRIC',
      requestedByUserId: 'user-1',
      maxAttempts: 1,
    });
    expect(repository.rangeQuery).toMatchObject({
      tenantId: 'tenant-1',
      cloudConnectionId: 'conn-1',
      sourceType: 'TECHNICAL_METRIC',
    });
  });

  test('does not duplicate technical backfill windows already covered by active jobs', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository);
    const rangeEnd = new Date(Date.now() + 60 * 60 * 1000);
    const coveredStart = new Date(Date.now() - 48 * 60 * 60 * 1000);

    repository.rangeJobs = [{
      id: 'existing-job',
      sourceType: 'TECHNICAL_METRIC',
      status: 'SUCCESS',
      targetStart: coveredStart,
      targetEnd: rangeEnd,
    }];

    const result = await service.queueTechnicalMetricBackfill({
      tenantId: 'tenant-1',
      userId: 'user-1',
      cloudConnectionId: 'conn-1',
      lookbackDays: 1,
      windowHours: 24,
    });

    expect(result.createdJobs).toHaveLength(0);
    expect(result.skippedWindows).toHaveLength(1);
    expect(repository.createdJobInputs).toEqual([]);
  });

  test('rejects technical metric backfill beyond OCI metric retention window', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository);

    await expect(service.queueTechnicalMetricBackfill({
      tenantId: 'tenant-1',
      userId: 'user-1',
      cloudConnectionId: 'conn-1',
      lookbackDays: 91,
      windowHours: 24,
    })).rejects.toThrow('lookbackDays must be between 1 and 90');
  });
});
