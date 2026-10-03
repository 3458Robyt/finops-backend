import type {
  ConfigureBillingSourceForConnectionInput,
  ConfigureBillingSourceForConnectionResult,
  ConfigureFocusSourceForConnectionInput,
  ConfigureFocusSourceForConnectionResult,
  ConfigureMetricDefinitionsForConnectionInput,
  ConfigureMetricDefinitionsForConnectionResult,
} from '../../domain/interfaces/ICloudConnectionRepository.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { isJsonObject } from './mappers/cloudConnectionMappers.js';
import { invalidatedValidationData } from './cloudConnectionMetadata.js';
import { configureFocusSourceMetadata } from '../ingestion/focusSourceMetadata.js';
import { hashMetricDimensions } from '../ingestion/metricDimensions.js';

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
    return this.prisma.$transaction(async (tx) => {
      const connection = await tx.cloudConnection.findFirst({
        where: { id: input.cloudConnectionId, tenantId: input.tenantId, status: 'ACTIVE' },
        select: { id: true, providerCode: true, metadata: true, defaultRegion: true, rootExternalId: true },
      });
      if (connection === null || (connection.providerCode !== 'aws' && connection.providerCode !== 'oci')) return null;

      const updatedKey = connection.providerCode === 'aws' ? 'awsMetricDefinitions' : 'ociMetricDefinitions';
      const metadata = isJsonObject(connection.metadata) ? { ...(connection.metadata as Record<string, unknown>) } : {};
      const existing = !input.replace && Array.isArray(metadata[updatedKey]) ? metadata[updatedKey] : [];
      const definitions = [...new Map(
        [...existing, ...input.definitions].map((definition) => [JSON.stringify(definition), definition]),
      ).values()];
      metadata[updatedKey] = definitions;

      await tx.cloudConnection.update({
        where: { id: connection.id },
        data: invalidatedValidationData(metadata),
      });

      const confirmedAt = new Date();
      if (input.replace && connection.providerCode === 'oci') {
        await tx.cloudMetricDefinition.updateMany({
          where: { tenantId: input.tenantId, cloudConnectionId: connection.id },
          data: { enabled: false, status: 'DISCOVERED' },
        });
      }
      if (input.replace && connection.providerCode === 'aws') {
        await tx.cloudMetricDefinition.updateMany({
          where: { tenantId: input.tenantId, cloudConnectionId: connection.id },
          data: { enabled: false, status: 'DISCOVERED' },
        });
      }
      for (const definition of input.definitions) {
        if (connection.providerCode === 'oci') {
          await this.upsertOciMetricDefinition(tx, input.tenantId, connection.id, connection.defaultRegion, definition, confirmedAt);
        } else {
          await this.upsertAwsMetricDefinition(tx, input.tenantId, connection.id, connection.rootExternalId, connection.defaultRegion, definition, confirmedAt);
        }
      }

      return {
        cloudConnectionId: connection.id,
        providerCode: connection.providerCode,
        updatedKey,
        configuredCount: definitions.length,
        replaced: input.replace,
      };
    });
  }

  private upsertOciMetricDefinition(
    tx: Prisma.TransactionClient,
    tenantId: string,
    cloudConnectionId: string,
    defaultRegion: string | null,
    definition: Readonly<Record<string, unknown>>,
    confirmedAt: Date,
  ) {
    const compartmentId = String(definition['compartmentId']);
    const namespace = String(definition['namespace']);
    const metricName = String(definition['metricName']);
    const externalResourceId = String(definition['resourceId'] ?? '');
    const regionId = typeof definition['regionId'] === 'string' ? definition['regionId'] : defaultRegion ?? '';
    const dimensions = readStringDimensions(definition['dimensions']);
    const dimensionsHash = hashMetricDimensions(dimensions);
    const shared = {
      tenantId,
      cloudConnectionId,
      regionId,
      compartmentId,
      namespace,
      metricName,
      externalResourceId,
      dimensionsHash,
      dimensions: dimensions === undefined ? Prisma.DbNull : dimensions as Prisma.InputJsonValue,
      metricUnit: typeof definition['unit'] === 'string' ? definition['unit'] : null,
      statistics: definition['statistics'] as Prisma.InputJsonValue,
      status: 'CONFIRMED',
      enabled: true,
      discoverySource: 'OCI_LIST_METRICS',
      lastSeenAt: confirmedAt,
      confirmedAt,
    };
    return tx.cloudMetricDefinition.upsert({
      where: {
        cloudConnectionId_regionId_namespace_metricName_compartmentId_externalResourceId_dimensionsHash: {
          cloudConnectionId,
          regionId,
          namespace,
          metricName,
          compartmentId,
          externalResourceId,
          dimensionsHash,
        },
      },
      create: shared,
      update: shared,
    });
  }

  private upsertAwsMetricDefinition(
    tx: Prisma.TransactionClient,
    tenantId: string,
    cloudConnectionId: string,
    accountId: string,
    defaultRegion: string | null,
    definition: Readonly<Record<string, unknown>>,
    confirmedAt: Date,
  ) {
    const namespace = String(definition['namespace']);
    const metricName = String(definition['metricName']);
    const externalResourceId = String(definition['externalResourceId'] ?? '');
    const regionId = typeof definition['region'] === 'string' ? definition['region'] : defaultRegion ?? '';
    const dimensions = readAwsStringDimensions(definition['dimensions']);
    const statistics = Array.isArray(definition['statistics']) ? definition['statistics'] : ['MEAN'];
    const dimensionsHash = hashMetricDimensions(dimensions);
    const shared = {
      tenantId,
      cloudConnectionId,
      regionId,
      compartmentId: accountId,
      namespace,
      metricName,
      externalResourceId,
      dimensionsHash,
      dimensions: dimensions === undefined ? Prisma.DbNull : dimensions as Prisma.InputJsonValue,
      metricUnit: typeof definition['unit'] === 'string' ? definition['unit'] : null,
      statistics: statistics as Prisma.InputJsonValue,
      status: 'CONFIRMED',
      enabled: true,
      discoverySource: 'AWS_CLOUDWATCH',
      lastSeenAt: confirmedAt,
      confirmedAt,
    };
    return tx.cloudMetricDefinition.upsert({
      where: {
        cloudConnectionId_regionId_namespace_metricName_compartmentId_externalResourceId_dimensionsHash: {
          cloudConnectionId, regionId, namespace, metricName, compartmentId: accountId, externalResourceId, dimensionsHash,
        },
      },
      create: shared,
      update: shared,
    });
  }

  private findActiveConnection(tenantId: string, cloudConnectionId: string) {
    return this.prisma.cloudConnection.findFirst({
      where: { id: cloudConnectionId, tenantId, status: 'ACTIVE' },
      select: { id: true, providerCode: true, metadata: true },
    });
  }
}

function readStringDimensions(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === 'string')
    ? Object.fromEntries(entries) as Record<string, string>
    : undefined;
}

function readAwsStringDimensions(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const dimensions = Object.fromEntries(value.flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    const entry = item as Record<string, unknown>;
    return typeof entry['Name'] === 'string' && typeof entry['Value'] === 'string'
      ? [[entry['Name'], entry['Value']]]
      : [];
  }));
  return Object.keys(dimensions).length === 0 ? undefined : dimensions;
}
