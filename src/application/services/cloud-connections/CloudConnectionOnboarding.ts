import type {
  CloudCredentialSummary,
  ConfigureBillingSourceForConnectionResult,
  ConfigureFocusSourceForConnectionResult,
  ConfigureMetricDefinitionsForConnectionResult,
  CreateCloudConnectionInput,
  ICloudConnectionRepository,
} from '../../../domain/interfaces/ICloudConnectionRepository.js';
import type {
  CloudConnectionValidationResult,
  CloudIngestionProvider,
  FocusSourcePreviewResult,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import type { CloudConnectionSummary, ProviderCatalogEntry } from '../../../domain/models/CloudConnection.js';
import { FinOpsBaseError } from '../../../domain/errors/errors.js';
import { serializeCapabilityValidation, withTimeout } from '../cloudConnectionPolicies.js';
import type {
  CloudConnectionOnboardingDetail,
  ConfigureBillingSourceInput,
  ConfigureFocusSourceInput,
  ConfigureMetricDefinitionsInput,
  PreviewFocusSourceInput,
  RegisterCloudConnectionInput,
  StoreOperationalCredentialInput,
  UpdateCloudConnectionInput,
  ValidateCloudConnectionInput,
} from './CloudConnectionContracts.js';
import {
  normalizeMetricDefinition,
  normalizeOperationalCredential,
  requireNonEmpty,
} from './CloudConnectionInputPolicy.js';

export class CloudConnectionOnboarding {
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
    const normalized = normalizeOperationalCredential(connection, input.payload);
    const credential = await this.repository.storeCredential({
      tenantId: input.tenantId,
      cloudConnectionId: input.cloudConnectionId,
      purpose: input.purpose,
      label: requireNonEmpty(input.label, 'label').slice(0, 120),
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

    const rootExternalId = requireNonEmpty(input.rootExternalId, 'rootExternalId');
    if (providerCode === 'aws' && !/^\d{12}$/.test(rootExternalId)) {
      throw new FinOpsBaseError('El AWS Account ID debe contener exactamente 12 dígitos.', 'VALIDATION_ERROR');
    }
    if (providerCode === 'oci' && !/^ocid1\.tenancy\.[a-z0-9.-]+$/i.test(rootExternalId)) {
      throw new FinOpsBaseError('El Tenancy OCID de OCI no es válido.', 'VALIDATION_ERROR');
    }
    const name = requireNonEmpty(input.name, 'name');
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
    const name = requireNonEmpty(input.name, 'name');
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
      normalizeMetricDefinition(connection.providerCode, definition, index),
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

}
