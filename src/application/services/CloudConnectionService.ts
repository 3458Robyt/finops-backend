import type {
  ConfigureFocusSourceForConnectionResult,
  CreateCloudConnectionInput,
  CreateIngestionJobInput,
  DataQualityCheckItem,
  ICloudConnectionRepository,
  IngestionReadinessSummary,
  IngestionJobHistoryItem,
  IngestionJobSummary,
} from '../../domain/interfaces/ICloudConnectionRepository.js';
import type {
  CloudConnectionSummary,
  IngestionHealthSummary,
  IngestionSourceType,
  ProviderCatalogEntry,
} from '../../domain/models/CloudConnection.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';

export interface RegisterCloudConnectionInput {
  readonly tenantId: string;
  readonly providerCode: string;
  readonly rootExternalId: string;
  readonly name: string;
  readonly defaultRegion?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ProvisionCloudConnectionInput {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly temporaryAdminCredential: Readonly<Record<string, unknown>>;
}

export interface ProvisionCloudConnectionResult {
  readonly cloudConnectionId: string;
  readonly adminCredentialStored: false;
  readonly adminCredentialDiscardedAt: Date;
  readonly status: 'PENDING_PROVIDER_AUTOMATION';
  readonly messages: readonly string[];
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
  readonly cloudConnectionId: string;
  readonly mode: 'location' | 'object';
  readonly values: Readonly<Record<string, string>>;
  readonly replace: boolean;
}

export class CloudConnectionService {
  constructor(private readonly repository: ICloudConnectionRepository) {}

  public listProviders(): Promise<readonly ProviderCatalogEntry[]> {
    return this.repository.listProviderCatalog();
  }

  public listConnections(tenantId: string): Promise<readonly CloudConnectionSummary[]> {
    return this.repository.listCloudConnectionsForTenant(tenantId);
  }

  public async registerConnection(
    input: RegisterCloudConnectionInput,
  ): Promise<CloudConnectionSummary> {
    const providerCode = input.providerCode.trim().toLowerCase();
    const provider = await this.repository.findProviderCatalog(providerCode);

    if (provider === null || !provider.enabled) {
      throw new FinOpsBaseError(
        `Provider "${input.providerCode}" is not enabled in the provider catalog`,
        'PROVIDER_NOT_ENABLED',
      );
    }

    const payload: CreateCloudConnectionInput = {
      tenantId: input.tenantId,
      providerCode,
      rootExternalId: this.requireNonEmpty(input.rootExternalId, 'rootExternalId'),
      name: this.requireNonEmpty(input.name, 'name'),
      ...(input.defaultRegion !== undefined && input.defaultRegion.trim() !== ''
        ? { defaultRegion: input.defaultRegion.trim() }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };

    return this.repository.createCloudConnection(payload);
  }

  public async provisionWithTemporaryAdmin(
    input: ProvisionCloudConnectionInput,
  ): Promise<ProvisionCloudConnectionResult> {
    const connection = await this.repository.findCloudConnectionForTenant(
      input.tenantId,
      input.cloudConnectionId,
    );

    if (connection === null) {
      throw new FinOpsBaseError('Cloud connection was not found for this tenant', 'NOT_FOUND');
    }

    if (Object.keys(input.temporaryAdminCredential).length === 0) {
      throw new FinOpsBaseError(
        'temporaryAdminCredential must contain the provider-specific admin payload',
        'VALIDATION_ERROR',
      );
    }

    return {
      cloudConnectionId: input.cloudConnectionId,
      adminCredentialStored: false,
      adminCredentialDiscardedAt: new Date(),
      status: 'PENDING_PROVIDER_AUTOMATION',
      messages: [
        'La credencial admin temporal fue recibida solo en memoria y no se persistio.',
        'La automatizacion especifica de AWS/OCI debe crear una credencial operativa minima antes de activar ingesta productiva.',
      ],
    };
  }

  public async validateConnection(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<CloudConnectionSummary> {
    const connection = await this.repository.findCloudConnectionForTenant(
      tenantId,
      cloudConnectionId,
    );

    if (connection === null) {
      throw new FinOpsBaseError('Cloud connection was not found for this tenant', 'NOT_FOUND');
    }

    await this.repository.markCloudConnectionValidated(cloudConnectionId, new Date());
    const validated = await this.repository.findCloudConnectionForTenant(tenantId, cloudConnectionId);

    if (validated === null) {
      throw new FinOpsBaseError('Cloud connection disappeared during validation', 'NOT_FOUND');
    }

    return validated;
  }

  public async queueIngestion(input: QueueIngestionInput): Promise<IngestionJobSummary> {
    if (input.targetEnd <= input.targetStart) {
      throw new FinOpsBaseError('targetEnd must be after targetStart', 'VALIDATION_ERROR');
    }

    const connection = await this.repository.findCloudConnectionForTenant(
      input.tenantId,
      input.cloudConnectionId,
    );

    if (connection === null) {
      throw new FinOpsBaseError('Cloud connection was not found for this tenant', 'NOT_FOUND');
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

  public async queueTechnicalMetricBackfill(
    input: QueueTechnicalBackfillInput,
  ): Promise<TechnicalBackfillResult> {
    const connection = await this.repository.findCloudConnectionForTenant(
      input.tenantId,
      input.cloudConnectionId,
    );

    if (connection === null) {
      throw new FinOpsBaseError('Cloud connection was not found for this tenant', 'NOT_FOUND');
    }

    const lookbackDays = this.resolveLookbackDays(input.lookbackDays);
    const windowHours = this.resolveWindowHours(input.windowHours);
    const rangeEnd = new Date();
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
        job.targetStart.getTime() <= window.targetStart.getTime()
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
      throw new FinOpsBaseError('Cloud connection was not found for this tenant', 'NOT_FOUND');
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
    const result = await this.repository.configureFocusSourceForConnection(input);

    if (result === null) {
      throw new FinOpsBaseError('Cloud connection was not found for this tenant', 'NOT_FOUND');
    }

    return result;
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
      throw new FinOpsBaseError('lookbackDays must be between 1 and 90', 'VALIDATION_ERROR');
    }

    return normalized;
  }

  private resolveWindowHours(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
      return 24;
    }

    const normalized = Math.floor(value);
    if (normalized < 1 || normalized > 24) {
      throw new FinOpsBaseError('windowHours must be between 1 and 24', 'VALIDATION_ERROR');
    }

    return normalized;
  }

  private requireNonEmpty(value: string, fieldName: string): string {
    const normalized = value.trim();

    if (normalized === '') {
      throw new FinOpsBaseError(`${fieldName} is required`, 'VALIDATION_ERROR');
    }

    return normalized;
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
