import { ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity } from '@smithy/types';
import type {
  CloudCapabilityValidation,
  CloudConnectionValidationResult,
  CloudIngestionConnection,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import {
  getCredential,
  optionalString,
  readObjectArray,
} from '../providerConfig.js';
import type {
  AwsCallerIdentityResponse,
  AwsCommandClient,
  AwsCostExplorerResponse,
  AwsDescribeInstancesResponse,
  AwsGetObjectResponse,
  AwsListMetricsResponse,
  AwsListObjectsResponse,
  AwsMetricDataResponse,
} from './awsContracts.js';
import { safeAwsProviderError } from './awsConfiguration.js';

type AwsCredential = NonNullable<ReturnType<typeof getCredential>>;

export interface AwsConnectionValidationDependencies {
  readonly assumeRole: (credential: AwsCredential, region: string) => Promise<AwsCredentialIdentity>;
  readonly createIdentityClient: (
    region: string,
    credentials: AwsCredentialIdentity,
  ) => AwsCommandClient<AwsCallerIdentityResponse>;
  readonly createEc2Client: (
    region: string,
    credentials: AwsCredentialIdentity,
  ) => AwsCommandClient<AwsDescribeInstancesResponse>;
  readonly createCostExplorerClient: (
    credentials: AwsCredentialIdentity,
  ) => AwsCommandClient<AwsCostExplorerResponse>;
  readonly createCloudWatchClient: (
    region: string,
    credentials: AwsCredentialIdentity,
  ) => AwsCommandClient<AwsMetricDataResponse & AwsListMetricsResponse>;
  readonly createS3Client: (
    region: string,
    credentials: AwsCredentialIdentity,
  ) => AwsCommandClient<AwsGetObjectResponse & AwsListObjectsResponse>;
}

export async function validateAwsConnection(
  connection: CloudIngestionConnection,
  dependencies: AwsConnectionValidationDependencies,
): Promise<CloudConnectionValidationResult> {
  const checkedAt = new Date();
  const credential = getCredential(connection.credentials, [
    'OPERATIONAL',
    'INVENTORY_READ',
    'METRICS_READ',
    'BILLING_EXPORT_READ',
    'STORAGE_READ',
  ]);
  if (credential === undefined) {
    return {
      providerCode: 'aws',
      authentication: {
        status: 'NOT_CONFIGURED',
        message: 'No hay una credencial AWS de lectura para autenticar la conexión.',
        checkedAt,
      },
      capabilities: missingCredentialCapabilities(checkedAt, 'No hay una credencial AWS de lectura activa.'),
    };
  }

  const region = optionalString(credential.payload['region']) ?? connection.defaultRegion ?? 'us-east-1';
  let assumed: AwsCredentialIdentity;
  try {
    assumed = await dependencies.assumeRole(credential, region);
  } catch (error) {
    const failure = failedCapability('IDENTITY', error, checkedAt);
    return {
      providerCode: 'aws',
      authentication: {
        status: 'REJECTED',
        message: 'AWS STS rechazó la autenticación del Role ARN o del External ID.',
        checkedAt,
      },
      capabilities: [
        failure,
        ...(['INVENTORY', 'COSTS', 'METRICS', 'STORAGE'] as const).map((capability) => ({
          capability,
          status: failure.status,
          message: 'No se puede comprobar esta capacidad porque AWS STS AssumeRole falló.',
          checkedAt,
        })),
      ],
    };
  }

  const identity = await validateAwsCall('IDENTITY', checkedAt, async () => {
    const client = dependencies.createIdentityClient(region, assumed);
    try {
      const response = await client.send(new GetCallerIdentityCommand({}));
      if (response.Account !== undefined && /^\d{12}$/.test(connection.rootExternalId) && response.Account !== connection.rootExternalId) {
        throw new Error('La cuenta devuelta por AWS no coincide con la conexión configurada.');
      }
      return {
        message: 'AWS AssumeRole e identidad validados.',
        metadata: {
          ...(response.Account !== undefined ? { accountId: response.Account } : {}),
          ...(response.Arn !== undefined ? { principalArn: response.Arn } : {}),
        },
      };
    } finally {
      client.destroy?.();
    }
  });

  const inventory = await validateAwsCall('INVENTORY', checkedAt, async () => {
    const client = dependencies.createEc2Client(region, assumed);
    try {
      await client.send(new DescribeInstancesCommand({ MaxResults: 5 }));
      return { message: 'Lectura de inventario EC2 disponible.', metadata: { region } };
    } finally {
      client.destroy?.();
    }
  });

  const costs = await validateAwsCall('COSTS', checkedAt, async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    const client = dependencies.createCostExplorerClient(assumed);
    try {
      await client.send(new GetCostAndUsageCommand({
        TimePeriod: { Start: toAwsDate(start), End: toAwsDate(end) },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
      }));
      return { message: 'AWS Cost Explorer disponible.' };
    } finally {
      client.destroy?.();
    }
  });

  const metrics = await validateAwsCall('METRICS', checkedAt, async () => {
    const client = dependencies.createCloudWatchClient(region, assumed);
    try {
      await client.send(new ListMetricsCommand({}));
      return { message: 'Lectura de métricas CloudWatch disponible.', metadata: { region } };
    } finally {
      client.destroy?.();
    }
  });

  const storage = await validateStorageCapability(connection, assumed, region, checkedAt, dependencies);
  return {
    providerCode: 'aws',
    authentication: {
      status: identity.status === 'AVAILABLE' ? 'VERIFIED' : 'RETRYABLE_ERROR',
      message: identity.status === 'AVAILABLE'
        ? 'AWS STS aceptó el AssumeRole y la identidad.'
        : 'AWS no pudo confirmar la identidad del rol; revisa el error de STS.',
      checkedAt,
    },
    capabilities: [identity, inventory, costs, metrics, storage],
  };
}

async function validateStorageCapability(
  connection: CloudIngestionConnection,
  credentials: AwsCredentialIdentity,
  defaultRegion: string,
  checkedAt: Date,
  dependencies: AwsConnectionValidationDependencies,
): Promise<CloudCapabilityValidation> {
  const location = readObjectArray(connection.metadata, 'awsFocusExportLocations')[0];
  const object = readObjectArray(connection.metadata, 'awsFocusExportObjects')[0];
  const bucket = optionalString(location?.['bucket']) ?? optionalString(object?.['bucket']);
  const prefix = optionalString(location?.['prefix']) ?? optionalString(object?.['key']) ?? '';
  if (bucket === undefined) {
    return {
      capability: 'STORAGE',
      status: 'NOT_CONFIGURED',
      message: 'Configura un bucket o prefijo FOCUS para validar almacenamiento S3.',
      checkedAt,
    };
  }

  const region = optionalString(location?.['region']) ?? optionalString(object?.['region']) ?? defaultRegion;
  return validateAwsCall('STORAGE', checkedAt, async () => {
    const client = dependencies.createS3Client(region, credentials);
    try {
      await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1,
      }));
      return { message: 'Lectura del almacenamiento FOCUS en S3 disponible.', metadata: { bucket, region } };
    } finally {
      client.destroy?.();
    }
  });
}

async function validateAwsCall(
  capability: CloudCapabilityValidation['capability'],
  checkedAt: Date,
  operation: () => Promise<{
    readonly message: string;
    readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  }>,
): Promise<CloudCapabilityValidation> {
  try {
    const result = await operation();
    return {
      capability,
      status: 'AVAILABLE',
      message: result.message,
      checkedAt,
      ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
    };
  } catch (error) {
    return failedCapability(capability, error, checkedAt);
  }
}

function failedCapability(
  capability: CloudCapabilityValidation['capability'],
  error: unknown,
  checkedAt: Date,
): CloudCapabilityValidation {
  const message = safeAwsProviderError(error);
  return {
    capability,
    status: /access.?denied|unauthori[sz]ed|not authorized|forbidden/i.test(message) ? 'DENIED' : 'ERROR',
    message,
    checkedAt,
  };
}

function missingCredentialCapabilities(
  checkedAt: Date,
  message: string,
): readonly CloudCapabilityValidation[] {
  return (['IDENTITY', 'INVENTORY', 'COSTS', 'METRICS', 'STORAGE'] as const).map((capability) => ({
    capability,
    status: 'NOT_CONFIGURED',
    message,
    checkedAt,
  }));
}

function toAwsDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
