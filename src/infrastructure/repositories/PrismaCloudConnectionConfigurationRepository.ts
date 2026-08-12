import type {
  ConfigureBillingSourceForConnectionInput,
  ConfigureBillingSourceForConnectionResult,
  ConfigureFocusSourceForConnectionInput,
  ConfigureFocusSourceForConnectionResult,
  ConfigureMetricDefinitionsForConnectionInput,
  ConfigureMetricDefinitionsForConnectionResult,
} from '../../domain/interfaces/ICloudConnectionRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { isJsonObject } from './mappers/cloudConnectionMappers.js';
import { invalidatedValidationData } from './cloudConnectionMetadata.js';
import { configureFocusSourceMetadata } from '../ingestion/focusSourceMetadata.js';

/**
 * Persists the provider-specific ingestion configuration of a cloud
 * connection. Keeping this metadata lifecycle separate prevents the main
 * connection repository from mixing connection identity, credentials, jobs
 * and source configuration in one adapter.
 */
export class PrismaCloudConnectionConfigurationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async configureFocusSourceForConnection(
    input: ConfigureFocusSourceForConnectionInput,
  ): Promise<ConfigureFocusSourceForConnectionResult | null> {
    const connection = await this.prisma.cloudConnection.findFirst({
      where: {
        id: input.cloudConnectionId,
        tenantId: input.tenantId,
        status: 'ACTIVE',
      },
      select: { id: true, providerCode: true, metadata: true },
    });
    if (connection === null) return null;

    const result = configureFocusSourceMetadata({
      provider: connection.providerCode,
      mode: input.mode,
      values: new Map(Object.entries(input.values)),
      existingMetadata: isJsonObject(connection.metadata)
        ? connection.metadata as Record<string, unknown>
        : {},
      replace: input.replace,
    });

    await this.prisma.cloudConnection.update({
      where: { id: connection.id },
      data: invalidatedValidationData(result.metadata),
    });

    return {
      cloudConnectionId: connection.id,
      providerCode: connection.providerCode,
      mode: input.mode,
      updatedKey: result.updatedKey,
      configuredCount: result.configuredCount,
      replaced: input.replace,
    };
  }

  public async configureBillingSourceForConnection(
    input: ConfigureBillingSourceForConnectionInput,
  ): Promise<ConfigureBillingSourceForConnectionResult | null> {
    const connection = await this.findActiveConnection(input.tenantId, input.cloudConnectionId);
    if (connection === null) return null;

    const metadata = isJsonObject(connection.metadata)
      ? { ...(connection.metadata as Record<string, unknown>), billingSourceMode: input.mode }
      : { billingSourceMode: input.mode };
    await this.prisma.cloudConnection.update({
      where: { id: connection.id },
      data: invalidatedValidationData(metadata),
    });
    return { cloudConnectionId: connection.id, providerCode: connection.providerCode, mode: input.mode };
  }

  public async configureMetricDefinitionsForConnection(
    input: ConfigureMetricDefinitionsForConnectionInput,
  ): Promise<ConfigureMetricDefinitionsForConnectionResult | null> {
    const connection = await this.findActiveConnection(input.tenantId, input.cloudConnectionId);
    if (connection === null || (connection.providerCode !== 'aws' && connection.providerCode !== 'oci')) return null;

    const updatedKey = connection.providerCode === 'aws' ? 'awsMetricDefinitions' : 'ociMetricDefinitions';
    const metadata = isJsonObject(connection.metadata) ? { ...(connection.metadata as Record<string, unknown>) } : {};
    const existing = !input.replace && Array.isArray(metadata[updatedKey]) ? metadata[updatedKey] : [];
    const definitions = [...new Map(
      [...existing, ...input.definitions].map((definition) => [JSON.stringify(definition), definition]),
    ).values()];

    metadata[updatedKey] = definitions;
    await this.prisma.cloudConnection.update({
      where: { id: connection.id },
      data: invalidatedValidationData(metadata),
    });
    return {
      cloudConnectionId: connection.id,
      providerCode: connection.providerCode,
      updatedKey,
      configuredCount: definitions.length,
      replaced: input.replace,
    };
  }

  private findActiveConnection(tenantId: string, cloudConnectionId: string) {
    return this.prisma.cloudConnection.findFirst({
      where: { id: cloudConnectionId, tenantId, status: 'ACTIVE' },
      select: { id: true, providerCode: true, metadata: true },
    });
  }
}
