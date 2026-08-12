import type {
  ConfigureBillingSourceForConnectionResult,
  ConfigureFocusSourceForConnectionResult,
  ConfigureMetricDefinitionsForConnectionResult,
  ICloudConnectionRepository,
} from '../../../domain/interfaces/ICloudConnectionRepository.js';
import type { CloudConnectionSummary } from '../../../domain/models/CloudConnection.js';
import { FinOpsBaseError } from '../../../domain/errors/errors.js';
import type {
  ConfigureBillingSourceInput,
  ConfigureFocusSourceInput,
  ConfigureMetricDefinitionsInput,
} from './CloudConnectionContracts.js';
import { normalizeMetricDefinition } from './CloudConnectionInputPolicy.js';

/**
 * Configura las fuentes de datos de una conexión cloud.
 *
 * Este colaborador mantiene juntas las operaciones que cambian el contrato
 * de ingesta (FOCUS, API de costos y definiciones de métricas), incluyendo la
 * normalización de entrada y la auditoría de cada cambio. No conoce la
 * validación de credenciales ni la ejecución de jobs.
 */
export class CloudConnectionSourceConfiguration {
  constructor(private readonly repository: ICloudConnectionRepository) {}

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

    if (result === null) throw missingConnectionError();
    await this.audit(input.tenantId, input.userId, input.cloudConnectionId, 'CLOUD_FOCUS_SOURCE_CONFIGURED', {
      mode: input.mode,
      configuredCount: result.configuredCount,
      replaced: input.replace,
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

    if (result === null) throw missingConnectionError();
    await this.audit(input.tenantId, input.userId, input.cloudConnectionId, 'CLOUD_BILLING_SOURCE_CONFIGURED', {
      mode: input.mode,
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
      throw new FinOpsBaseError(
        'La conexión cloud no existe, está deshabilitada o no soporta métricas.',
        'NOT_FOUND',
      );
    }
    await this.audit(input.tenantId, input.userId, input.cloudConnectionId, 'CLOUD_METRIC_DEFINITIONS_CONFIGURED', {
      configuredCount: result.configuredCount,
      replaced: input.replace,
    });
    return result;
  }

  private async requireConnection(tenantId: string, cloudConnectionId: string): Promise<CloudConnectionSummary> {
    const connection = await this.repository.findCloudConnectionForTenant(tenantId, cloudConnectionId);
    if (connection === null) throw missingConnectionError();
    return connection;
  }

  private audit(
    tenantId: string,
    userId: string,
    cloudConnectionId: string,
    action: 'CLOUD_FOCUS_SOURCE_CONFIGURED' | 'CLOUD_BILLING_SOURCE_CONFIGURED' | 'CLOUD_METRIC_DEFINITIONS_CONFIGURED',
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    return this.repository.createCloudAuditEvent({
      tenantId,
      actorUserId: userId,
      action,
      entityType: 'CLOUD_CONNECTION',
      entityId: cloudConnectionId,
      metadata,
    });
  }
}

function missingConnectionError(): FinOpsBaseError {
  return new FinOpsBaseError('La conexión cloud no existe o no pertenece al tenant activo.', 'NOT_FOUND');
}
