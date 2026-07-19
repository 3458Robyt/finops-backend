import type {
  BillingSourceMode,
  CloudCredentialPurpose,
  CloudCredentialSummary,
  ConfigureBillingSourceForConnectionResult,
  ConfigureFocusSourceForConnectionResult,
  ConfigureMetricDefinitionsForConnectionResult,
  CreateCloudConnectionInput,
  CreateIngestionJobInput,
  DataQualityCheckItem,
  ICloudConnectionRepository,
  IngestionReadinessSummary,
  IngestionJobHistoryItem,
  IngestionJobSummary,
} from '../../domain/interfaces/ICloudConnectionRepository.js';
import type {
  CloudCapabilityValidation,
  CloudConnectionValidationResult,
  CloudIngestionProvider,
  FocusSourcePreviewResult,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import type {
  CloudConnectionSummary,
  IngestionHealthSummary,
  IngestionSourceType,
  ProviderCatalogEntry,
} from '../../domain/models/CloudConnection.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';

export interface RegisterCloudConnectionInput {
  readonly tenantId: string;
  readonly userId?: string;
  readonly providerCode: string;
  readonly rootExternalId: string;
  readonly name: string;
  readonly defaultRegion?: string;
}

export interface QueueIngestionInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cloudConnectionId: string;
  readonly sourceType: IngestionSourceType;
  readonly targetStart: Date;
  readonly targetEnd: Date;
}

export interface QueueTechnicalBackfillInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cloudConnectionId: string;
  readonly lookbackDays?: number;
  readonly windowHours?: number;
}

export interface TechnicalBackfillWindow {
  readonly targetStart: Date;
  readonly targetEnd: Date;
}

export interface TechnicalBackfillResult {
  readonly cloudConnectionId: string;
  readonly sourceType: 'TECHNICAL_METRIC';
  readonly lookbackDays: number;
  readonly windowHours: number;
  readonly rangeStart: Date;
  readonly rangeEnd: Date;
  readonly createdJobs: readonly IngestionJobSummary[];
  readonly skippedWindows: readonly TechnicalBackfillWindow[];
}

export interface ConfigureFocusSourceInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cloudConnectionId: string;
  readonly mode: 'location' | 'object';
  readonly values: Readonly<Record<string, string>>;
  readonly replace: boolean;
}

export interface ManageIngestionJobsInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cloudConnectionId: string;
  readonly sourceType: IngestionSourceType;
}

export interface UpdateCloudConnectionInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cloudConnectionId: string;
  readonly name: string;
  readonly defaultRegion?: string;
}

export interface ConfigureBillingSourceInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cloudConnectionId: string;
  readonly mode: BillingSourceMode;
}

export interface ConfigureMetricDefinitionsInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cloudConnectionId: string;
  readonly definitions: readonly unknown[];
  readonly replace: boolean;
}

export interface StoreOperationalCredentialInput {
  readonly tenantId: string;
  readonly userId?: string;
  readonly cloudConnectionId: string;
  readonly purpose: CloudCredentialPurpose;
  readonly label: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface CloudConnectionOnboardingDetail {
  readonly connection: CloudConnectionSummary;
  readonly credentials: readonly CloudCredentialSummary[];
  readonly readiness: IngestionReadinessSummary['connections'][number] | null;
  readonly issues: readonly (IngestionReadinessSummary['issues'][number])[];
}

export interface ActivateCloudConnectionInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cloudConnectionId: string;
  readonly billingLookbackDays?: number;
  readonly metricLookbackDays?: number;
  readonly metricWindowHours?: number;
}

export interface ActivateCloudConnectionResult {
  readonly cloudConnectionId: string;
  readonly createdJobs: readonly IngestionJobSummary[];
  readonly skipped: readonly IngestionSourceType[];
  readonly unavailable: readonly IngestionSourceType[];
}

export interface ValidateCloudConnectionInput {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly userId?: string;
}

export interface PreviewFocusSourceInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cloudConnectionId: string;
  readonly limit?: number;
}

export class CloudConnectionService {
  private readonly providers: ReadonlyMap<string, CloudIngestionProvider>;

  constructor(
    private readonly repository: ICloudConnectionRepository,
    providers: readonly CloudIngestionProvider[] = [],
  ) {
    this.providers = new Map(providers.map((provider) => [provider.providerCode, provider]));
  }

  public listProviders(): Promise<readonly ProviderCatalogEntry[]> {
    return this.repository.listProviderCatalog();
  }

  public listConnections(tenantId: string): Promise<readonly CloudConnectionSummary[]> {
    return this.repository.listCloudConnectionsForTenant(tenantId);
  }

  public async setConnectionStatus(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly cloudConnectionId: string;
    readonly status: 'ACTIVE' | 'DISABLED';
  }): Promise<CloudConnectionSummary> {
    const connection = await this.repository.setCloudConnectionStatus(
      input.tenantId, input.cloudConnectionId, input.status,
    );
    if (connection === null) {
      throw new FinOpsBaseError('La conexión cloud no existe o no pertenece al tenant activo.', 'NOT_FOUND');
    }
    await this.repository.createCloudAuditEvent({
      tenantId: input.tenantId, actorUserId: input.userId,
      action: input.status === 'DISABLED' ? 'CLOUD_CONNECTION_DISABLED' : 'CLOUD_CONNECTION_ENABLED',
      entityType: 'CLOUD_CONNECTION', entityId: input.cloudConnectionId,
      metadata: { status: input.status },
    });
    return connection;
  }

  public async getOnboardingDetail(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<CloudConnectionOnboardingDetail> {
    const [connection, credentials, readiness] = await Promise.all([
      this.repository.findCloudConnectionForTenant(tenantId, cloudConnectionId),
      this.repository.listCredentialSummaries(tenantId, cloudConnectionId),
      this.repository.listIngestionReadinessForTenant(tenantId),
    ]);
    if (connection === null || credentials === null) {
      throw new FinOpsBaseError('La conexión cloud no existe o no pertenece al tenant activo.', 'NOT_FOUND');
    }

    return {
      connection,
      credentials,
      readiness: readiness.connections.find((item) => item.id === cloudConnectionId) ?? null,
      issues: readiness.issues.filter((issue) => issue.connectionId === cloudConnectionId),
    };
  }

  public async storeOperationalCredential(
    input: StoreOperationalCredentialInput,
  ): Promise<CloudCredentialSummary> {
    const connection = await this.requireConnection(input.tenantId, input.cloudConnectionId);
    const normalized = this.normalizeCredential(connection, input.payload);
    const credential = await this.repository.storeCredential({
      tenantId: input.tenantId,
      cloudConnectionId: input.cloudConnectionId,
      purpose: input.purpose,
      label: this.requireNonEmpty(input.label, 'label').slice(0, 120),
      payload: normalized.payload,
      externalPrincipalId: normalized.externalPrincipalId,
    });
    if (credential === null) {
      throw new FinOpsBaseError('La conexión cloud no existe o no pertenece al tenant activo.', 'NOT_FOUND');
    }

    if (input.userId !== undefined) {
      await this.repository.createCloudAuditEvent({
        tenantId: input.tenantId, actorUserId: input.userId,
        action: 'CLOUD_CREDENTIAL_STORED', entityType: 'CLOUD_CREDENTIAL', entityId: credential.id,
        metadata: {
          cloudConnectionId: input.cloudConnectionId,
          purpose: credential.purpose,
          ...(credential.externalPrincipalId !== undefined ? { externalPrincipalId: credential.externalPrincipalId } : {}),
        },
      });
    }

    return credential;
  }

  public async revokeOperationalCredential(
    tenantId: string,
    cloudConnectionId: string,
    credentialId: string,
    userId?: string,
  ): Promise<CloudCredentialSummary> {
    const credential = await this.repository.revokeCredential(
      tenantId,
      cloudConnectionId,
      credentialId,
    );
    if (credential === null) {
      throw new FinOpsBaseError('La credencial no existe o no pertenece a esta conexión.', 'NOT_FOUND');
    }

    if (userId !== undefined) {
      await this.repository.createCloudAuditEvent({
        tenantId, actorUserId: userId,
        action: 'CLOUD_CREDENTIAL_REVOKED', entityType: 'CLOUD_CREDENTIAL', entityId: credential.id,
        metadata: { cloudConnectionId, purpose: credential.purpose },
      });
    }

    return credential;
  }

  public async registerConnection(
    input: RegisterCloudConnectionInput,
  ): Promise<CloudConnectionSummary> {
    const providerCode = input.providerCode.trim().toLowerCase();
    const provider = await this.repository.findProviderCatalog(providerCode);

    if (provider === null || !provider.enabled) {
      throw new FinOpsBaseError(
        `El proveedor "${input.providerCode}" no está habilitado.`,
        'PROVIDER_NOT_ENABLED',
      );
    }

    const rootExternalId = this.requireNonEmpty(input.rootExternalId, 'rootExternalId');
    if (providerCode === 'aws' && !/^\d{12}$/.test(rootExternalId)) {
      throw new FinOpsBaseError('El AWS Account ID debe contener exactamente 12 dígitos.', 'VALIDATION_ERROR');
    }
    if (providerCode === 'oci' && !/^ocid1\.tenancy\.[a-z0-9.-]+$/i.test(rootExternalId)) {
      throw new FinOpsBaseError('El Tenancy OCID de OCI no es válido.', 'VALIDATION_ERROR');
    }
    const name = this.requireNonEmpty(input.name, 'name');
    if (name.length > 120) throw new FinOpsBaseError('El nombre no puede superar 120 caracteres.', 'VALIDATION_ERROR');
    const defaultRegion = input.defaultRegion?.trim();
    if (defaultRegion !== undefined && defaultRegion !== '' && !/^[a-z0-9-]{2,64}$/i.test(defaultRegion)) {
      throw new FinOpsBaseError('La región cloud no tiene un formato válido.', 'VALIDATION_ERROR');
    }

    const payload: CreateCloudConnectionInput = {
      tenantId: input.tenantId,
      providerCode,
      rootExternalId,
      name,
      ...(defaultRegion !== undefined && defaultRegion !== ''
        ? { defaultRegion }
        : {}),
    };

    const connection = await this.repository.createCloudConnection(payload);
    if (input.userId !== undefined) {
      await this.repository.createCloudAuditEvent({
        tenantId: input.tenantId, actorUserId: input.userId,
        action: 'CLOUD_CONNECTION_CREATED', entityType: 'CLOUD_CONNECTION', entityId: connection.id,
        metadata: { providerCode, rootExternalId },
      });
    }
    return connection;
  }

  public async updateConnection(input: UpdateCloudConnectionInput): Promise<CloudConnectionSummary> {
    const name = this.requireNonEmpty(input.name, 'name');
    if (name.length > 120) {
      throw new FinOpsBaseError('El nombre no puede superar 120 caracteres.', 'VALIDATION_ERROR');
    }
    const defaultRegion = input.defaultRegion?.trim();
    if (defaultRegion !== undefined && defaultRegion !== '' && !/^[a-z0-9-]{2,64}$/i.test(defaultRegion)) {
      throw new FinOpsBaseError('La región cloud no tiene un formato válido.', 'VALIDATION_ERROR');
    }
    const connection = await this.repository.updateCloudConnection({
      tenantId: input.tenantId,
      cloudConnectionId: input.cloudConnectionId,
      name,
      ...(defaultRegion !== undefined && defaultRegion !== '' ? { defaultRegion } : {}),
    });
    if (connection === null) {
      throw new FinOpsBaseError('La conexión cloud no existe o no pertenece al tenant activo.', 'NOT_FOUND');
    }
    await this.repository.createCloudAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'CLOUD_CONNECTION_UPDATED',
      entityType: 'CLOUD_CONNECTION',
      entityId: input.cloudConnectionId,
      metadata: { name, defaultRegion: defaultRegion ?? null },
    });
    return connection;
  }

  public async validateConnection(
    input: ValidateCloudConnectionInput,
  ): Promise<CloudConnectionValidationResult> {
    const connection = await this.repository.getIngestionConnectionForTenant(
      input.tenantId,
      input.cloudConnectionId,
    );
    if (connection === null) {
      throw new FinOpsBaseError('La conexión cloud no existe o no pertenece al tenant activo.', 'NOT_FOUND');
    }

    const provider = this.providers.get(connection.providerCode);
    if (provider === undefined) {
      throw new FinOpsBaseError('No existe un validador para este proveedor cloud.', 'PROVIDER_NOT_ENABLED');
    }

    const validation = await withTimeout(
      provider.validate(connection),
      20_000,
      'La validación cloud superó el tiempo máximo de 20 segundos.',
    );
    const checkedAt = new Date();
    const validationRecord = {
      providerCode: validation.providerCode,
      checkedAt: checkedAt.toISOString(),
      capabilities: validation.capabilities.map(serializeCapabilityValidation),
    };
    const saved = await this.repository.saveConnectionValidation(
      input.tenantId,
      input.cloudConnectionId,
      validationRecord,
      checkedAt,
    );
    if (saved === null) {
      throw new FinOpsBaseError('La conexión dejó de estar disponible durante la validación.', 'NOT_FOUND');
    }

    if (input.userId !== undefined) {
      await this.repository.createCloudAuditEvent({
        tenantId: input.tenantId, actorUserId: input.userId,
        action: 'CLOUD_CONNECTION_VALIDATED', entityType: 'CLOUD_CONNECTION', entityId: input.cloudConnectionId,
        metadata: { providerCode: validation.providerCode, capabilities: validation.capabilities.map(({ capability, status }) => ({ capability, status })) },
      });
    }

    return validation;
  }

  public async previewFocusSource(input: PreviewFocusSourceInput): Promise<FocusSourcePreviewResult> {
    const connection = await this.repository.getIngestionConnectionForTenant(input.tenantId, input.cloudConnectionId);
    if (connection === null) {
      throw new FinOpsBaseError('La conexión cloud no existe, está deshabilitada o no pertenece al tenant activo.', 'NOT_FOUND');
    }
    const provider = this.providers.get(connection.providerCode);
    if (provider?.previewFocus === undefined) {
      throw new FinOpsBaseError('Este proveedor no soporta la previsualización FOCUS.', 'PROVIDER_NOT_ENABLED');
    }
    const limit = input.limit === undefined ? 100 : Math.min(200, Math.max(1, Math.floor(input.limit)));
    const preview = await withTimeout(
      provider.previewFocus(connection, limit),
      20_000,
      'La previsualización FOCUS superó el tiempo máximo de 20 segundos.',
    );
    await this.repository.createCloudAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'CLOUD_FOCUS_SOURCE_PREVIEWED',
      entityType: 'CLOUD_CONNECTION',
      entityId: input.cloudConnectionId,
      metadata: {
        configuredLocations: preview.configuredLocations,
        configuredObjects: preview.configuredObjects,
        discoveredObjects: preview.discoveredObjects,
        approximateBytes: preview.approximateBytes,
      },
    });
    return preview;
  }

  public async activateConnection(
    input: ActivateCloudConnectionInput,
  ): Promise<ActivateCloudConnectionResult> {
    const connection = await this.requireConnection(input.tenantId, input.cloudConnectionId);
    if (connection.status !== 'ACTIVE') {
      throw new FinOpsBaseError('Habilita la conexión antes de iniciar la sincronización.', 'VALIDATION_ERROR');
    }
    if (!hasUsableValidation(connection)) {
      throw new FinOpsBaseError(
        'Valida la identidad y al menos una capacidad de datos antes de activar la cuenta.',
        'VALIDATION_ERROR',
      );
    }
    const now = currentMinute();
    const createdJobs: IngestionJobSummary[] = [];
    const skipped: IngestionSourceType[] = [];
    const unavailable: IngestionSourceType[] = [];
    const capabilities = availableCapabilities(connection);
    const billingLookbackDays = this.resolveRangeDays(input.billingLookbackDays, 30, 366, 'billingLookbackDays');

    for (const request of [
      {
        sourceType: 'INVENTORY' as const,
        targetStart: new Date(now.getTime() - 5 * 60 * 1000),
        targetEnd: now,
      },
      {
        sourceType: 'BILLING_EXPORT' as const,
        targetStart: new Date(now.getTime() - billingLookbackDays * 24 * 60 * 60 * 1000),
        targetEnd: now,
      },
    ]) {
      const supported = request.sourceType === 'INVENTORY'
        ? capabilities.has('INVENTORY')
        : hasUsableBillingSource(connection, capabilities);
      if (!supported) {
        unavailable.push(request.sourceType);
        continue;
      }
      const job = await this.queueIfUncovered({ ...input, ...request });
      if (job === null) skipped.push(request.sourceType);
      else createdJobs.push(job);
    }

    if (capabilities.has('METRICS') && hasMetricDefinitions(connection)) {
      const backfill = await this.queueTechnicalMetricBackfill({
        tenantId: input.tenantId,
        userId: input.userId,
        cloudConnectionId: input.cloudConnectionId,
        ...(input.metricLookbackDays !== undefined ? { lookbackDays: input.metricLookbackDays } : {}),
        ...(input.metricWindowHours !== undefined ? { windowHours: input.metricWindowHours } : {}),
      });
      createdJobs.push(...backfill.createdJobs);
      if (backfill.createdJobs.length === 0) skipped.push('TECHNICAL_METRIC');
    } else {
      unavailable.push('TECHNICAL_METRIC');
    }

    await this.repository.createCloudAuditEvent({
      tenantId: input.tenantId, actorUserId: input.userId,
      action: 'CLOUD_CONNECTION_ACTIVATED', entityType: 'CLOUD_CONNECTION', entityId: input.cloudConnectionId,
      metadata: { createdJobIds: createdJobs.map((job) => job.id), skipped, unavailable },
    });

    return { cloudConnectionId: input.cloudConnectionId, createdJobs, skipped, unavailable };
  }

  public async queueIngestion(input: QueueIngestionInput): Promise<IngestionJobSummary> {
    if (input.targetEnd <= input.targetStart) {
      throw new FinOpsBaseError('La fecha final debe ser posterior a la fecha inicial.', 'VALIDATION_ERROR');
    }

    const connection = await this.repository.findCloudConnectionForTenant(
      input.tenantId,
      input.cloudConnectionId,
    );

    if (connection === null) {
      throw new FinOpsBaseError('La conexión cloud no existe o no pertenece al tenant activo.', 'NOT_FOUND');
    }

    const jobInput: CreateIngestionJobInput = {
      tenantId: input.tenantId,
      cloudConnectionId: input.cloudConnectionId,
      sourceType: input.sourceType,
      requestedByUserId: input.userId,
      targetStart: input.targetStart,
      targetEnd: input.targetEnd,
    };

    return this.repository.createIngestionJob(jobInput);
  }

  public async retryFailedIngestionJobs(input: ManageIngestionJobsInput): Promise<readonly IngestionJobSummary[]> {
    await this.requireConnection(input.tenantId, input.cloudConnectionId);
    const failed = await this.repository.listFailedIngestionJobsForConnection(
      input.tenantId,
      input.cloudConnectionId,
      input.sourceType,
    );
    const jobs: IngestionJobSummary[] = [];
    const queuedWindows = new Set<string>();
    for (const previous of failed) {
      const windowKey = `${previous.sourceType}:${previous.targetStart.toISOString()}:${previous.targetEnd.toISOString()}`;
      if (queuedWindows.has(windowKey)) continue;
      queuedWindows.add(windowKey);
      jobs.push(await this.repository.createIngestionJob({
        tenantId: input.tenantId,
        cloudConnectionId: input.cloudConnectionId,
        sourceType: previous.sourceType,
        requestedByUserId: input.userId,
        targetStart: previous.targetStart,
        targetEnd: previous.targetEnd,
      }));
    }
    await this.repository.createCloudAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'CLOUD_INGESTION_FAILED_RETRIED',
      entityType: 'CLOUD_CONNECTION',
      entityId: input.cloudConnectionId,
      metadata: { sourceType: input.sourceType, failedJobs: failed.length, queuedJobs: jobs.length },
    });
    return jobs;
  }

  public async cancelPendingIngestionJobs(input: ManageIngestionJobsInput): Promise<number> {
    await this.requireConnection(input.tenantId, input.cloudConnectionId);
    const cancelled = await this.repository.cancelPendingIngestionJobs(
      input.tenantId,
      input.cloudConnectionId,
      input.sourceType,
    );
    await this.repository.createCloudAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'CLOUD_INGESTION_PENDING_CANCELLED',
      entityType: 'CLOUD_CONNECTION',
      entityId: input.cloudConnectionId,
      metadata: { sourceType: input.sourceType, cancelled },
    });
    return cancelled;
  }

  public async queueTechnicalMetricBackfill(
    input: QueueTechnicalBackfillInput,
  ): Promise<TechnicalBackfillResult> {
    const connection = await this.repository.findCloudConnectionForTenant(
      input.tenantId,
      input.cloudConnectionId,
    );

    if (connection === null) {
      throw new FinOpsBaseError('La conexión cloud no existe o no pertenece al tenant activo.', 'NOT_FOUND');
    }

    const lookbackDays = this.resolveLookbackDays(input.lookbackDays);
    const windowHours = this.resolveWindowHours(input.windowHours);
    const rangeEnd = currentMinute();
    const rangeStart = new Date(rangeEnd.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const windows = buildBackfillWindows(rangeStart, rangeEnd, windowHours);
    const existingJobs = [...await this.repository.listIngestionJobsForConnectionRange({
      tenantId: input.tenantId,
      cloudConnectionId: input.cloudConnectionId,
      sourceType: 'TECHNICAL_METRIC',
      targetStart: rangeStart,
      targetEnd: rangeEnd,
    })];

    const createdJobs: IngestionJobSummary[] = [];
    const skippedWindows: TechnicalBackfillWindow[] = [];

    for (const window of windows) {
      const covered = existingJobs.some((job) =>
        job.status !== 'FAILED'
        && job.status !== 'CANCELLED'
        && job.targetStart.getTime() <= window.targetStart.getTime()
        && job.targetEnd.getTime() >= window.targetEnd.getTime(),
      );

      if (covered) {
        skippedWindows.push(window);
        continue;
      }

      const job = await this.repository.createIngestionJob({
        tenantId: input.tenantId,
        cloudConnectionId: input.cloudConnectionId,
        sourceType: 'TECHNICAL_METRIC',
        requestedByUserId: input.userId,
        targetStart: window.targetStart,
        targetEnd: window.targetEnd,
        maxAttempts: 1,
      });
      createdJobs.push(job);
      existingJobs.push(job);
    }

    return {
      cloudConnectionId: input.cloudConnectionId,
      sourceType: 'TECHNICAL_METRIC',
      lookbackDays,
      windowHours,
      rangeStart,
      rangeEnd,
      createdJobs,
      skippedWindows,
    };
  }

  public async getHealth(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<IngestionHealthSummary> {
    const health = await this.repository.getIngestionHealth(tenantId, cloudConnectionId);

    if (health === null) {
      throw new FinOpsBaseError('La conexión cloud no existe o no pertenece al tenant activo.', 'NOT_FOUND');
    }

    return health;
  }

  /**
   * Lista el historial de trabajos de ingesta del tenant (todas sus conexiones),
   * del más reciente al más antiguo. El `limit` se acota al rango [1, 200] con
   * un valor por defecto de 50.
   */
  public listIngestionHistory(
    tenantId: string,
    limit?: number,
  ): Promise<readonly IngestionJobHistoryItem[]> {
    return this.repository.listIngestionJobsForTenant(tenantId, this.clampLimit(limit));
  }

  /**
   * Lista los controles de calidad de datos del tenant, del más reciente al más
   * antiguo. El `limit` se acota al rango [1, 200] con un valor por defecto de 50.
   */
  public listDataQualityChecks(
    tenantId: string,
    limit?: number,
  ): Promise<readonly DataQualityCheckItem[]> {
    return this.repository.listDataQualityChecksForTenant(tenantId, this.clampLimit(limit));
  }

  public getIngestionReadiness(tenantId: string): Promise<IngestionReadinessSummary> {
    return this.repository.listIngestionReadinessForTenant(tenantId);
  }

  public async configureFocusSource(
    input: ConfigureFocusSourceInput,
  ): Promise<ConfigureFocusSourceForConnectionResult> {
    const result = await this.repository.configureFocusSourceForConnection({
      tenantId: input.tenantId,
      cloudConnectionId: input.cloudConnectionId,
      mode: input.mode,
      values: input.values,
      replace: input.replace,
    });

    if (result === null) {
      throw new FinOpsBaseError('La conexión cloud no existe o no pertenece al tenant activo.', 'NOT_FOUND');
    }

    await this.repository.createCloudAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'CLOUD_FOCUS_SOURCE_CONFIGURED',
      entityType: 'CLOUD_CONNECTION',
      entityId: input.cloudConnectionId,
      metadata: { mode: input.mode, configuredCount: result.configuredCount, replaced: input.replace },
    });
    return result;
  }

  public async configureBillingSource(
    input: ConfigureBillingSourceInput,
  ): Promise<ConfigureBillingSourceForConnectionResult> {
    const result = await this.repository.configureBillingSourceForConnection({
      tenantId: input.tenantId,
      cloudConnectionId: input.cloudConnectionId,
      mode: input.mode,
    });

    if (result === null) {
      throw new FinOpsBaseError('La conexión cloud no existe o no pertenece al tenant activo.', 'NOT_FOUND');
    }

    await this.repository.createCloudAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'CLOUD_BILLING_SOURCE_CONFIGURED',
      entityType: 'CLOUD_CONNECTION',
      entityId: input.cloudConnectionId,
      metadata: { mode: input.mode },
    });
    return result;
  }

  public async configureMetricDefinitions(
    input: ConfigureMetricDefinitionsInput,
  ): Promise<ConfigureMetricDefinitionsForConnectionResult> {
    const connection = await this.requireConnection(input.tenantId, input.cloudConnectionId);
    if (input.definitions.length === 0 || input.definitions.length > 100) {
      throw new FinOpsBaseError('Configura entre 1 y 100 definiciones de métricas.', 'VALIDATION_ERROR');
    }
    const definitions = input.definitions.map((definition, index) =>
      this.normalizeMetricDefinition(connection.providerCode, definition, index),
    );
    const result = await this.repository.configureMetricDefinitionsForConnection({
      tenantId: input.tenantId,
      cloudConnectionId: input.cloudConnectionId,
      definitions,
      replace: input.replace,
    });
    if (result === null) {
      throw new FinOpsBaseError('La conexión cloud no existe, está deshabilitada o no soporta métricas.', 'NOT_FOUND');
    }
    await this.repository.createCloudAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'CLOUD_METRIC_DEFINITIONS_CONFIGURED',
      entityType: 'CLOUD_CONNECTION',
      entityId: input.cloudConnectionId,
      metadata: { configuredCount: result.configuredCount, replaced: input.replace },
    });
    return result;
  }

  private async requireConnection(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<CloudConnectionSummary> {
    const connection = await this.repository.findCloudConnectionForTenant(tenantId, cloudConnectionId);
    if (connection === null) {
      throw new FinOpsBaseError('La conexión cloud no existe o no pertenece al tenant activo.', 'NOT_FOUND');
    }

    return connection;
  }

  private normalizeCredential(
    connection: CloudConnectionSummary,
    payload: Readonly<Record<string, unknown>>,
  ): { readonly payload: Readonly<Record<string, unknown>>; readonly externalPrincipalId: string } {
    if (connection.providerCode === 'aws') {
      const roleArn = this.requirePayloadString(payload, 'roleArn');
      const externalId = this.requirePayloadString(payload, 'externalId');
      const region = this.optionalPayloadString(payload, 'region') ?? connection.defaultRegion ?? 'us-east-1';
      const match = /^arn:aws[a-z-]*:iam::(\d{12}):role\/(.+)$/.exec(roleArn);
      if (match === null) {
        throw new FinOpsBaseError('El Role ARN debe ser un ARN válido de un rol IAM de AWS.', 'VALIDATION_ERROR');
      }
      if (/^\d{12}$/.test(connection.rootExternalId) && match[1] !== connection.rootExternalId) {
        throw new FinOpsBaseError('La cuenta del Role ARN no coincide con el AWS Account ID configurado.', 'VALIDATION_ERROR');
      }

      return {
        payload: { roleArn, externalId, region, sessionName: 'finops-ingestion-worker' },
        externalPrincipalId: roleArn,
      };
    }

    if (connection.providerCode === 'oci') {
      const tenancyId = this.requirePayloadString(payload, 'tenancyId');
      const userId = this.requirePayloadString(payload, 'userId');
      const fingerprint = this.requirePayloadString(payload, 'fingerprint');
      const privateKey = this.requirePayloadString(payload, 'privateKey');
      const region = this.optionalPayloadString(payload, 'region') ?? connection.defaultRegion;
      if (tenancyId !== connection.rootExternalId) {
        throw new FinOpsBaseError('El Tenancy OCID de la credencial no coincide con la conexión.', 'VALIDATION_ERROR');
      }
      if (!/^ocid1\.tenancy\./.test(tenancyId) || !/^ocid1\.user\./.test(userId)) {
        throw new FinOpsBaseError('El Tenancy OCID y el User OCID deben ser identificadores OCI válidos.', 'VALIDATION_ERROR');
      }
      if (!/-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(privateKey)) {
        throw new FinOpsBaseError('La clave privada debe estar en formato PEM.', 'VALIDATION_ERROR');
      }
      if (region === undefined) {
        throw new FinOpsBaseError('La región es obligatoria para las credenciales OCI.', 'VALIDATION_ERROR');
      }
      const passphrase = this.optionalPayloadString(payload, 'passphrase');

      return {
        payload: {
          tenancyId,
          userId,
          fingerprint,
          privateKey,
          region,
          ...(passphrase !== undefined ? { passphrase } : {}),
        },
        externalPrincipalId: userId,
      };
    }

    throw new FinOpsBaseError('El onboarding de credenciales solo está disponible para AWS y OCI.', 'PROVIDER_NOT_ENABLED');
  }

  private async queueIfUncovered(input: QueueIngestionInput): Promise<IngestionJobSummary | null> {
    const existing = await this.repository.listIngestionJobsForConnectionRange(input);
    const covered = existing.some((job) =>
      job.status !== 'FAILED'
      && job.status !== 'CANCELLED'
      && job.targetStart.getTime() <= input.targetStart.getTime()
      && job.targetEnd.getTime() >= input.targetEnd.getTime());

    return covered ? null : this.queueIngestion(input);
  }

  private requirePayloadString(payload: Readonly<Record<string, unknown>>, fieldName: string): string {
    const value = payload[fieldName];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new FinOpsBaseError(`El campo ${fieldName} es obligatorio.`, 'VALIDATION_ERROR');
    }

    return value.trim();
  }

  private optionalPayloadString(
    payload: Readonly<Record<string, unknown>>,
    fieldName: string,
  ): string | undefined {
    const value = payload[fieldName];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  }

  private resolveRangeDays(
    value: number | undefined,
    fallback: number,
    maximum: number,
    fieldName: string,
  ): number {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 1 || value > maximum) {
      throw new FinOpsBaseError(`El campo ${fieldName} debe estar entre 1 y ${maximum}.`, 'VALIDATION_ERROR');
    }

    return Math.floor(value);
  }

  /**
   * Normaliza y acota el límite de resultados al rango [1, 200]. Valores no
   * finitos o ausentes usan el valor por defecto (50); los decimales se truncan.
   */
  private clampLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) {
      return 50;
    }

    return Math.min(200, Math.max(1, Math.floor(limit)));
  }

  private resolveLookbackDays(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
      return 90;
    }

    const normalized = Math.floor(value);
    if (normalized < 1 || normalized > 90) {
      throw new FinOpsBaseError('El rango histórico debe estar entre 1 y 90 días.', 'VALIDATION_ERROR');
    }

    return normalized;
  }

  private resolveWindowHours(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
      return 24;
    }

    const normalized = Math.floor(value);
    if (normalized < 1 || normalized > 24) {
      throw new FinOpsBaseError('La ventana debe estar entre 1 y 24 horas.', 'VALIDATION_ERROR');
    }

    return normalized;
  }

  private requireNonEmpty(value: string, fieldName: string): string {
    const normalized = value.trim();

    if (normalized === '') {
      throw new FinOpsBaseError(`El campo ${fieldName} es obligatorio.`, 'VALIDATION_ERROR');
    }

    return normalized;
  }

  private normalizeMetricDefinition(
    providerCode: string,
    value: unknown,
    index: number,
  ): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) {
      throw new FinOpsBaseError(`definitions[${index}] debe ser un objeto.`, 'VALIDATION_ERROR');
    }
    const text = (field: string): string => this.requirePayloadString(value, field);
    const optional = (field: string): string | undefined => this.optionalPayloadString(value, field);
    if (providerCode === 'oci') {
      const query = optional('query');
      const unit = optional('unit');
      return {
        compartmentId: text('compartmentId'),
        namespace: text('namespace'),
        metricName: text('metricName'),
        resourceId: text('resourceId'),
        ...(query !== undefined ? { query } : {}),
        ...(unit !== undefined ? { unit } : {}),
      };
    }
    if (providerCode === 'aws') {
      const dimensions = value['dimensions'];
      if (!Array.isArray(dimensions) || dimensions.length === 0 || dimensions.length > 20) {
        throw new FinOpsBaseError(`definitions[${index}].dimensions debe contener entre 1 y 20 dimensiones.`, 'VALIDATION_ERROR');
      }
      const region = optional('region');
      const unit = optional('unit');
      return {
        externalResourceId: text('externalResourceId'),
        namespace: text('namespace'),
        metricName: text('metricName'),
        stat: text('stat'),
        dimensions: dimensions.map((dimension, dimensionIndex) => {
          if (!isRecord(dimension)) {
            throw new FinOpsBaseError(`definitions[${index}].dimensions[${dimensionIndex}] no es válida.`, 'VALIDATION_ERROR');
          }
          return {
            Name: this.requirePayloadString(dimension, 'Name'),
            Value: this.requirePayloadString(dimension, 'Value'),
          };
        }),
        ...(region !== undefined ? { region } : {}),
        ...(unit !== undefined ? { unit } : {}),
      };
    }
    throw new FinOpsBaseError('El proveedor no soporta configuración de métricas.', 'VALIDATION_ERROR');
  }
}

function buildBackfillWindows(
  rangeStart: Date,
  rangeEnd: Date,
  windowHours: number,
): readonly TechnicalBackfillWindow[] {
  const windows: TechnicalBackfillWindow[] = [];
  const windowMs = windowHours * 60 * 60 * 1000;
  let cursor = new Date(rangeStart);

  while (cursor.getTime() < rangeEnd.getTime()) {
    const targetStart = new Date(cursor);
    const targetEnd = new Date(Math.min(cursor.getTime() + windowMs, rangeEnd.getTime()));
    windows.push({ targetStart, targetEnd });
    cursor = targetEnd;
  }

  return windows;
}

function currentMinute(): Date {
  return new Date(Math.floor(Date.now() / 60_000) * 60_000);
}

function serializeCapabilityValidation(
  validation: CloudCapabilityValidation,
): Readonly<Record<string, unknown>> {
  return {
    capability: validation.capability,
    status: validation.status,
    message: validation.message,
    checkedAt: validation.checkedAt.toISOString(),
    ...(validation.metadata !== undefined ? { metadata: validation.metadata } : {}),
  };
}

function hasUsableValidation(connection: CloudConnectionSummary): boolean {
  if (connection.lastValidatedAt === undefined) return false;
  const validation = connection.metadata?.['capabilityValidation'];
  if (!isRecord(validation) || !Array.isArray(validation['capabilities'])) return false;
  const available = validation['capabilities'].filter((item): item is Readonly<Record<string, unknown>> =>
    isRecord(item) && item['status'] === 'AVAILABLE',
  );
  return available.some((item) => item['capability'] === 'IDENTITY')
    && available.some((item) => ['INVENTORY', 'COSTS', 'METRICS', 'STORAGE'].includes(String(item['capability'])));
}

function availableCapabilities(connection: CloudConnectionSummary): ReadonlySet<string> {
  const validation = connection.metadata?.['capabilityValidation'];
  if (!isRecord(validation) || !Array.isArray(validation['capabilities'])) return new Set();
  return new Set(validation['capabilities']
    .filter((item): item is Readonly<Record<string, unknown>> => isRecord(item) && item['status'] === 'AVAILABLE')
    .map((item) => String(item['capability'])));
}

function hasUsableBillingSource(connection: CloudConnectionSummary, capabilities: ReadonlySet<string>): boolean {
  const mode = connection.metadata?.['billingSourceMode'];
  const focusAvailable = capabilities.has('STORAGE') && hasFocusConfiguration(connection);
  if (mode === 'FOCUS') return focusAvailable;
  if (mode === 'PROVIDER_API') return capabilities.has('COSTS');
  return focusAvailable || capabilities.has('COSTS');
}

function hasFocusConfiguration(connection: CloudConnectionSummary): boolean {
  const keys = connection.providerCode === 'aws'
    ? ['awsFocusExportObjects', 'awsFocusExportLocations']
    : ['ociFocusReportObjects', 'ociFocusReportLocations'];
  return keys.some((key) => Array.isArray(connection.metadata?.[key]) && connection.metadata[key].length > 0);
}

function hasMetricDefinitions(connection: CloudConnectionSummary): boolean {
  const key = connection.providerCode === 'aws' ? 'awsMetricDefinitions' : 'ociMetricDefinitions';
  return Array.isArray(connection.metadata?.[key]) && connection.metadata[key].length > 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new FinOpsBaseError(message, 'PROVIDER_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
