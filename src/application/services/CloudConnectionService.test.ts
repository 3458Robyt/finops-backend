import { describe, expect, test } from 'vitest';
import { CloudConnectionService } from './CloudConnectionService.js';
import type {
  ConfigureFocusSourceForConnectionInput,
  ConfigureFocusSourceForConnectionResult,
  ConfigureBillingSourceForConnectionInput,
  ConfigureBillingSourceForConnectionResult,
  ConfigureMetricDefinitionsForConnectionInput,
  ConfigureMetricDefinitionsForConnectionResult,
  CloudCredentialSummary,
  CreateCloudAuditEventInput,
  CreateCloudConnectionInput,
  CreateIngestionJobInput,
  DataQualityCheckItem,
  ICloudConnectionRepository,
  IngestionJobRangeQuery,
  IngestionJobWindowItem,
  IngestionReadinessSummary,
  IngestionJobHistoryItem,
  IngestionJobSummary,
  StoreCloudCredentialInput,
  UpdateCloudConnectionInput,
} from '../../domain/interfaces/ICloudConnectionRepository.js';
import type {
  CloudConnectionValidationResult,
  CloudIngestionConnection,
  CloudIngestionProvider,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
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

const awsValidator: CloudIngestionProvider = {
  providerCode: 'aws',
  async validate(): Promise<CloudConnectionValidationResult> {
    return {
      providerCode: 'aws',
      capabilities: [{
        capability: 'IDENTITY',
        status: 'AVAILABLE',
        message: 'AWS identity validated',
        checkedAt: new Date('2026-07-15T00:00:00.000Z'),
      }, {
        capability: 'INVENTORY', status: 'AVAILABLE', message: 'EC2 available', checkedAt: new Date('2026-07-15T00:00:00.000Z'),
      }, {
        capability: 'COSTS', status: 'AVAILABLE', message: 'Cost Explorer available', checkedAt: new Date('2026-07-15T00:00:00.000Z'),
      }, {
        capability: 'METRICS', status: 'AVAILABLE', message: 'CloudWatch available', checkedAt: new Date('2026-07-15T00:00:00.000Z'),
      }, {
        capability: 'STORAGE', status: 'AVAILABLE', message: 'S3 available', checkedAt: new Date('2026-07-15T00:00:00.000Z'),
      }],
    };
  },
  async previewFocus() {
    return {
      providerCode: 'aws',
      configuredLocations: 1,
      configuredObjects: 0,
      discoveredObjects: 2,
      approximateBytes: 2048,
      sizedObjects: 1,
      supportedFormats: ['csv', 'csv.gz'] as const,
      errors: [],
      objects: [{ name: 'focus.csv.gz', location: 's3://bucket/focus.csv.gz', source: 'discovered' as const, sizeBytes: 2048 }],
    };
  },
  async collect() {
    return {
      apiCallCount: 0,
      objectsProcessed: 0,
      focusRows: [],
      resources: [],
      metricSamples: [],
      warnings: [],
      coverage: {},
    };
  },
};

class FakeCloudConnectionRepository implements ICloudConnectionRepository {
  public createdConnectionInput: CreateCloudConnectionInput | null = null;
  public createdJobInput: CreateIngestionJobInput | null = null;
  public createdJobInputs: CreateIngestionJobInput[] = [];
  public configuredFocusInput: ConfigureFocusSourceForConnectionInput | null = null;
  public configuredMetricInput: ConfigureMetricDefinitionsForConnectionInput | null = null;
  public storedCredentialInput: StoreCloudCredentialInput | null = null;
  public savedValidation: Readonly<Record<string, unknown>> | null = null;
  public auditEvents: CreateCloudAuditEventInput[] = [];
  public rangeQuery: IngestionJobRangeQuery | null = null;
  public rangeJobs: IngestionJobWindowItem[] = [];
  public failedJobs: IngestionJobWindowItem[] = [];
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
        capability: 'CONNECTION',
        message: 'No active OCI cloud connection found for this tenant.',
        affectedData: ['Datos cloud'],
        action: 'Create connection',
        actionCode: 'CREATE_CONNECTION',
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
    lastValidatedAt: new Date('2026-07-15T00:00:00.000Z'),
    metadata: {
      capabilityValidation: {
        capabilities: [
          { capability: 'IDENTITY', status: 'AVAILABLE' },
          { capability: 'INVENTORY', status: 'AVAILABLE' },
          { capability: 'COSTS', status: 'AVAILABLE' },
          { capability: 'METRICS', status: 'AVAILABLE' },
          { capability: 'STORAGE', status: 'AVAILABLE' },
        ],
      },
      billingSourceMode: 'AUTO',
      awsFocusExportLocations: [{ bucket: 'focus-fixture', prefix: 'exports/' }],
      awsMetricDefinitions: [{ externalResourceId: 'i-fixture', namespace: 'AWS/EC2', metricName: 'CPUUtilization' }],
    },
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
  };
  public credentials: CloudCredentialSummary[] = [];

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

  public async updateCloudConnection(input: UpdateCloudConnectionInput): Promise<CloudConnectionSummary | null> {
    if (this.connection === null) return null;
    this.connection = {
      ...this.connection,
      name: input.name,
      ...(input.defaultRegion !== undefined ? { defaultRegion: input.defaultRegion } : {}),
    };
    return this.connection;
  }

  public async setCloudConnectionStatus(
    _tenantId: string,
    _cloudConnectionId: string,
    status: 'ACTIVE' | 'DISABLED',
  ): Promise<CloudConnectionSummary | null> {
    if (this.connection === null) return null;
    this.connection = { ...this.connection, status };
    return this.connection;
  }

  public async listCredentialSummaries(): Promise<readonly CloudCredentialSummary[] | null> {
    return this.connection === null ? null : this.credentials;
  }

  public async storeCredential(input: StoreCloudCredentialInput): Promise<CloudCredentialSummary | null> {
    if (this.connection === null) return null;
    this.storedCredentialInput = input;
    const credential: CloudCredentialSummary = {
      id: 'credential-1',
      purpose: input.purpose,
      status: 'ACTIVE',
      label: input.label,
      ...(input.externalPrincipalId !== undefined ? { externalPrincipalId: input.externalPrincipalId } : {}),
      createdAt: new Date('2026-07-15T00:00:00.000Z'),
    };
    this.credentials = [credential];
    return credential;
  }

  public async revokeCredential(): Promise<CloudCredentialSummary | null> {
    const credential = this.credentials[0];
    return credential === undefined ? null : { ...credential, status: 'REVOKED', revokedAt: new Date() };
  }

  public async getIngestionConnectionForTenant(): Promise<CloudIngestionConnection | null> {
    if (this.connection === null) return null;
    return {
      id: this.connection.id,
      tenantId: this.connection.tenantId,
      providerCode: this.connection.providerCode,
      rootExternalId: this.connection.rootExternalId,
      credentials: [{
        purpose: 'OPERATIONAL',
        payload: {
          roleArn: 'arn:aws:iam::123456789012:role/FinOpsReadOnly',
          externalId: 'tenant-1-external-id',
        },
      }],
    };
  }

  public async saveConnectionValidation(
    _tenantId: string,
    _connectionId: string,
    validation: Readonly<Record<string, unknown>>,
  ): Promise<CloudConnectionSummary | null> {
    this.savedValidation = validation;
    return this.connection;
  }

  public async createCloudAuditEvent(input: CreateCloudAuditEventInput): Promise<void> {
    this.auditEvents.push(input);
  }

  public async markCloudConnectionValidated(): Promise<void> {}

  public async createIngestionJob(input: CreateIngestionJobInput): Promise<IngestionJobSummary> {
    this.createdJobInput = input;
    this.createdJobInputs.push(input);
    const job: IngestionJobSummary = {
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
    this.rangeJobs.push(job);
    return job;
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

  public async configureBillingSourceForConnection(
    input: ConfigureBillingSourceForConnectionInput,
  ): Promise<ConfigureBillingSourceForConnectionResult | null> {
    return this.connection === null ? null : {
      cloudConnectionId: input.cloudConnectionId,
      providerCode: this.connection.providerCode,
      mode: input.mode,
    };
  }

  public async configureMetricDefinitionsForConnection(
    input: ConfigureMetricDefinitionsForConnectionInput,
  ): Promise<ConfigureMetricDefinitionsForConnectionResult | null> {
    this.configuredMetricInput = input;
    return this.connection === null ? null : {
      cloudConnectionId: input.cloudConnectionId,
      providerCode: this.connection.providerCode,
      updatedKey: this.connection.providerCode === 'aws' ? 'awsMetricDefinitions' : 'ociMetricDefinitions',
      configuredCount: input.definitions.length,
      replaced: input.replace,
    };
  }

  public async listIngestionJobsForConnectionRange(
    input: IngestionJobRangeQuery,
  ): Promise<readonly IngestionJobWindowItem[]> {
    this.rangeQuery = input;
    return this.rangeJobs.filter((job) => job.sourceType === input.sourceType
      && job.targetStart < input.targetEnd
      && job.targetEnd > input.targetStart);
  }

  public async listFailedIngestionJobsForConnection(): Promise<readonly IngestionJobWindowItem[]> {
    return this.failedJobs;
  }

  public async cancelPendingIngestionJobs(
    _tenantId: string,
    _connectionId: string,
    sourceType: IngestionJobWindowItem['sourceType'],
  ): Promise<number> {
    const pending = this.rangeJobs.filter((job) => job.sourceType === sourceType && job.status === 'PENDING');
    this.rangeJobs = this.rangeJobs.map((job) => pending.some((item) => item.id === job.id)
      ? { ...job, status: 'CANCELLED' }
      : job);
    return pending.length;
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

  test('normalizes AWS role credentials without accepting account passwords', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository);

    const result = await service.storeOperationalCredential({
      tenantId: 'tenant-1',
      cloudConnectionId: 'conn-1',
      purpose: 'OPERATIONAL',
      label: 'AWS FinOps read only',
      payload: {
        roleArn: 'arn:aws:iam::123456789012:role/FinOpsReadOnly',
        externalId: 'tenant-1-external-id',
        region: 'us-east-1',
      },
    });

    expect(result.externalPrincipalId).toBe('arn:aws:iam::123456789012:role/FinOpsReadOnly');
    expect(repository.storedCredentialInput?.payload).toEqual({
      roleArn: 'arn:aws:iam::123456789012:role/FinOpsReadOnly',
      externalId: 'tenant-1-external-id',
      region: 'us-east-1',
      sessionName: 'finops-ingestion-worker',
    });
  });

  test('updates only non-sensitive connection fields and audits the change', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository);

    const connection = await service.updateConnection({
      tenantId: 'tenant-1',
      userId: 'user-1',
      cloudConnectionId: 'conn-1',
      name: 'AWS Producción',
      defaultRegion: 'us-east-2',
    });

    expect(connection).toMatchObject({ name: 'AWS Producción', defaultRegion: 'us-east-2' });
    expect(repository.auditEvents[0]).toMatchObject({ action: 'CLOUD_CONNECTION_UPDATED' });
  });

  test('rejects malformed AWS account identifiers before persistence', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository);

    await expect(service.registerConnection({
      tenantId: 'tenant-1', providerCode: 'aws', rootExternalId: 'not-an-account', name: 'AWS',
    })).rejects.toThrow('12 dígitos');
    expect(repository.createdConnectionInput).toBeNull();
  });

  test('disables a tenant connection without deleting its history', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository);

    const connection = await service.setConnectionStatus({
      tenantId: 'tenant-1', userId: 'user-1', cloudConnectionId: 'conn-1', status: 'DISABLED',
    });

    expect(connection.status).toBe('DISABLED');
    expect(repository.auditEvents[0]).toMatchObject({ action: 'CLOUD_CONNECTION_DISABLED', entityId: 'conn-1' });
  });

  test('validates provider capabilities and persists only the safe result', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository, [awsValidator]);

    const validation = await service.validateConnection({ tenantId: 'tenant-1', cloudConnectionId: 'conn-1', userId: 'user-1' });

    expect(validation.capabilities[0]?.status).toBe('AVAILABLE');
    expect(repository.savedValidation).toMatchObject({ providerCode: 'aws' });
    expect(repository.auditEvents[0]).toMatchObject({
      action: 'CLOUD_CONNECTION_VALIDATED',
      tenantId: 'tenant-1',
      actorUserId: 'user-1',
    });
    expect(JSON.stringify(repository.auditEvents[0])).not.toContain('tenant-1-external-id');
  });

  test('previews FOCUS objects without persisting rows or exposing credentials', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository, [awsValidator]);

    const preview = await service.previewFocusSource({
      tenantId: 'tenant-1', userId: 'user-1', cloudConnectionId: 'conn-1', limit: 10,
    });

    expect(preview).toMatchObject({ discoveredObjects: 2, approximateBytes: 2048 });
    expect(repository.createdJobInputs).toEqual([]);
    expect(JSON.stringify(repository.auditEvents)).not.toContain('tenant-1-external-id');
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
      userId: 'user-1',
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

  test('normalizes and stores AWS metric definitions without accepting arbitrary fields', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository);

    const result = await service.configureMetricDefinitions({
      tenantId: 'tenant-1', userId: 'user-1', cloudConnectionId: 'conn-1', replace: true,
      definitions: [{
        externalResourceId: 'i-123', namespace: 'AWS/EC2', metricName: 'CPUUtilization', stat: 'Average',
        dimensions: [{ Name: 'InstanceId', Value: 'i-123' }], ignoredSecret: 'must-not-persist',
      }],
    });

    expect(result.updatedKey).toBe('awsMetricDefinitions');
    expect(repository.configuredMetricInput?.definitions[0]).toEqual({
      externalResourceId: 'i-123', namespace: 'AWS/EC2', metricName: 'CPUUtilization', stat: 'Average',
      dimensions: [{ Name: 'InstanceId', Value: 'i-123' }],
    });
    expect(repository.auditEvents[0]).toMatchObject({ action: 'CLOUD_METRIC_DEFINITIONS_CONFIGURED' });
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

  test('retries each failed ingestion window once and can cancel pending backfill jobs', async () => {
    const repository = new FakeCloudConnectionRepository();
    const failed = {
      id: 'failed-1', sourceType: 'TECHNICAL_METRIC' as const, status: 'FAILED' as const,
      targetStart: new Date('2026-07-01T00:00:00.000Z'), targetEnd: new Date('2026-07-02T00:00:00.000Z'),
    };
    repository.failedJobs = [failed, { ...failed, id: 'failed-duplicate' }];
    const service = new CloudConnectionService(repository);

    const retried = await service.retryFailedIngestionJobs({
      tenantId: 'tenant-1', userId: 'user-1', cloudConnectionId: 'conn-1', sourceType: 'TECHNICAL_METRIC',
    });
    const cancelled = await service.cancelPendingIngestionJobs({
      tenantId: 'tenant-1', userId: 'user-1', cloudConnectionId: 'conn-1', sourceType: 'TECHNICAL_METRIC',
    });

    expect(retried).toHaveLength(1);
    expect(cancelled).toBe(1);
    expect(repository.auditEvents.map((item) => item.action)).toEqual([
      'CLOUD_INGESTION_FAILED_RETRIED', 'CLOUD_INGESTION_PENDING_CANCELLED',
    ]);
  });

  test('activates the same connection idempotently within the same scheduling minute', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository);

    const first = await service.activateConnection({
      tenantId: 'tenant-1', userId: 'user-1', cloudConnectionId: 'conn-1',
      billingLookbackDays: 1, metricLookbackDays: 1, metricWindowHours: 24,
    });
    const second = await service.activateConnection({
      tenantId: 'tenant-1', userId: 'user-1', cloudConnectionId: 'conn-1',
      billingLookbackDays: 1, metricLookbackDays: 1, metricWindowHours: 24,
    });

    expect(first.createdJobs).toHaveLength(3);
    expect(second.createdJobs).toHaveLength(0);
    expect(second.skipped).toEqual(['INVENTORY', 'BILLING_EXPORT', 'TECHNICAL_METRIC']);
    expect(repository.createdJobInputs).toHaveLength(3);
  });

  test('does not enqueue sources whose permissions or configuration are unavailable', async () => {
    const repository = new FakeCloudConnectionRepository();
    repository.connection = {
      ...repository.connection!,
      metadata: {
        capabilityValidation: {
          capabilities: [
            { capability: 'IDENTITY', status: 'AVAILABLE' },
            { capability: 'INVENTORY', status: 'AVAILABLE' },
            { capability: 'COSTS', status: 'DENIED' },
            { capability: 'METRICS', status: 'AVAILABLE' },
            { capability: 'STORAGE', status: 'DENIED' },
          ],
        },
      },
    };
    const service = new CloudConnectionService(repository);

    const activation = await service.activateConnection({
      tenantId: 'tenant-1', userId: 'user-1', cloudConnectionId: 'conn-1',
      billingLookbackDays: 1, metricLookbackDays: 1, metricWindowHours: 24,
    });

    expect(activation.createdJobs.map((job) => job.sourceType)).toEqual(['INVENTORY']);
    expect(activation.skipped).toEqual([]);
    expect(activation.unavailable).toEqual(['BILLING_EXPORT', 'TECHNICAL_METRIC']);
  });

  test('completes the reanudable onboarding flow without exposing or duplicating secrets', async () => {
    const repository = new FakeCloudConnectionRepository();
    const service = new CloudConnectionService(repository, [awsValidator]);

    const credential = await service.storeOperationalCredential({
      tenantId: 'tenant-1',
      userId: 'user-1',
      cloudConnectionId: 'conn-1',
      purpose: 'OPERATIONAL',
      label: 'Rol FinOps read-only',
      payload: {
        roleArn: 'arn:aws:iam::123456789012:role/FinOpsReadOnly',
        externalId: 'tenant-1-external-id',
        region: 'us-east-1',
        ignoredPassword: 'must-not-persist',
      },
    });
    const validation = await service.validateConnection({
      tenantId: 'tenant-1', cloudConnectionId: 'conn-1', userId: 'user-1',
    });
    await service.configureBillingSource({
      tenantId: 'tenant-1', userId: 'user-1', cloudConnectionId: 'conn-1', mode: 'AUTO',
    });
    await service.configureFocusSource({
      tenantId: 'tenant-1', userId: 'user-1', cloudConnectionId: 'conn-1', mode: 'location', replace: true,
      values: { bucket: 'focus-fixture', prefix: 'exports/', region: 'us-east-1' },
    });
    await service.configureMetricDefinitions({
      tenantId: 'tenant-1', userId: 'user-1', cloudConnectionId: 'conn-1', replace: true,
      definitions: [{
        externalResourceId: 'i-fixture', namespace: 'AWS/EC2', metricName: 'CPUUtilization', stat: 'Average',
        dimensions: [{ Name: 'InstanceId', Value: 'i-fixture' }],
      }],
    });
    const activation = await service.activateConnection({
      tenantId: 'tenant-1', userId: 'user-1', cloudConnectionId: 'conn-1',
      billingLookbackDays: 1, metricLookbackDays: 1, metricWindowHours: 24,
    });

    expect(credential).not.toHaveProperty('payload');
    expect(repository.storedCredentialInput?.payload).toEqual({
      roleArn: 'arn:aws:iam::123456789012:role/FinOpsReadOnly',
      externalId: 'tenant-1-external-id',
      region: 'us-east-1',
      sessionName: 'finops-ingestion-worker',
    });
    expect(validation.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: 'IDENTITY', status: 'AVAILABLE' }),
    ]));
    expect(activation.createdJobs.map((job) => job.sourceType).sort()).toEqual([
      'BILLING_EXPORT', 'INVENTORY', 'TECHNICAL_METRIC',
    ]);
    expect(new Set(repository.auditEvents.map((event) => event.action))).toEqual(new Set([
      'CLOUD_CREDENTIAL_STORED',
      'CLOUD_CONNECTION_VALIDATED',
      'CLOUD_BILLING_SOURCE_CONFIGURED',
      'CLOUD_FOCUS_SOURCE_CONFIGURED',
      'CLOUD_METRIC_DEFINITIONS_CONFIGURED',
      'CLOUD_CONNECTION_ACTIVATED',
    ]));
  });

  test('does not activate a connection before a usable validation', async () => {
    const repository = new FakeCloudConnectionRepository();
    repository.connection = repository.connection === null ? null : {
      ...repository.connection,
      lastValidatedAt: undefined,
      metadata: undefined,
    };
    const service = new CloudConnectionService(repository);

    await expect(service.activateConnection({
      tenantId: 'tenant-1', userId: 'user-1', cloudConnectionId: 'conn-1',
    })).rejects.toThrow('Valida la identidad');
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
    })).rejects.toThrow('entre 1 y 90 días');
  });
});
