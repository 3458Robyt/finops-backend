import {
  CloudWatchClient,
  ListMetricsCommand,
} from '@aws-sdk/client-cloudwatch';
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import type { AwsCredentialIdentity } from '@smithy/types';
import type {
  CloudIngestionJobContext,
  CloudIngestionConnection,
  CloudConnectionValidationResult,
  CloudCapabilityValidation,
  CloudIngestionProvider,
  CloudIngestionResult,
  FocusSourcePreviewResult,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import {
  getCredential,
  optionalString,
  readObjectArray,
  requireString,
} from './providerConfig.js';
import type {
  AwsAssumeRoleResponse,
  AwsCallerIdentityResponse,
  AwsCommandClient,
  AwsCostExplorerResponse,
  AwsDescribeInstancesResponse,
  AwsGetObjectResponse,
  AwsListObjectsResponse,
  AwsMetricDataResponse,
} from './aws/awsContracts.js';
import { emptyAwsIngestionResult, safeAwsProviderError } from './aws/awsConfiguration.js';
import { collectAwsInventory } from './aws/AwsInventoryCollector.js';
import { collectAwsTechnicalMetrics } from './aws/AwsMetricCollector.js';
import { collectAwsBilling, previewAwsFocus } from './aws/AwsBillingCollector.js';

export class AwsSdkIngestionProvider implements CloudIngestionProvider {
  public readonly providerCode = 'aws';

  public async validate(connection: CloudIngestionConnection): Promise<CloudConnectionValidationResult> {
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
        providerCode: this.providerCode,
        capabilities: missingCredentialCapabilities(checkedAt, 'No hay una credencial AWS de lectura activa.'),
      };
    }

    const region = optionalString(credential.payload['region']) ?? connection.defaultRegion ?? 'us-east-1';
    let assumed: AwsCredentialIdentity;
    try {
      assumed = await this.assumeRole(credential, region);
    } catch (error) {
      const failure = failedCapability('IDENTITY', error, checkedAt);
      return {
        providerCode: this.providerCode,
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
      const response = await this.createIdentityClient(region, assumed).send(new GetCallerIdentityCommand({}));
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
    });

    const inventory = await validateAwsCall('INVENTORY', checkedAt, async () => {
      await this.createEc2Client(region, assumed).send(new DescribeInstancesCommand({ MaxResults: 5 }));
      return { message: 'Lectura de inventario EC2 disponible.', metadata: { region } };
    });

    const costs = await validateAwsCall('COSTS', checkedAt, async () => {
      const end = new Date();
      const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
      await this.createCostExplorerClient(assumed).send(new GetCostAndUsageCommand({
        TimePeriod: { Start: toAwsDate(start), End: toAwsDate(end) },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
      }));
      return { message: 'AWS Cost Explorer disponible.' };
    });

    const metrics = await validateAwsCall('METRICS', checkedAt, async () => {
      await this.createCloudWatchClient(region, assumed).send(new ListMetricsCommand({}));
      return { message: 'Lectura de métricas CloudWatch disponible.', metadata: { region } };
    });

    const storage = await this.validateStorageCapability(connection, assumed, region, checkedAt);
    return { providerCode: this.providerCode, capabilities: [identity, inventory, costs, metrics, storage] };
  }

  public async previewFocus(connection: CloudIngestionConnection, limit: number): Promise<FocusSourcePreviewResult> {
    return previewAwsFocus(connection, limit, {
      assumeRole: (credential, region) => this.assumeRole(credential, region),
      createS3Client: (region, credentials) => this.createS3Client(region, credentials),
      createCostExplorerClient: (credentials) => this.createCostExplorerClient(credentials),
    });
  }

  public async collect(job: CloudIngestionJobContext): Promise<CloudIngestionResult> {
    if (job.sourceType === 'BILLING_EXPORT') {
      return collectAwsBilling(job, {
        assumeRole: (credential, region) => this.assumeRole(credential, region),
        createS3Client: (region, credentials) => this.createS3Client(region, credentials),
        createCostExplorerClient: (credentials) => this.createCostExplorerClient(credentials),
      });
    }

    if (job.sourceType === 'INVENTORY') {
      const inventory = await collectAwsInventory(job, {
        assumeRole: (credential, region) => this.assumeRole(credential, region),
        createEc2Client: (region, credentials) => this.createEc2Client(region, credentials),
      });
      return {
        apiCallCount: inventory.apiCallCount,
        objectsProcessed: inventory.resources.length,
        focusRows: [],
        resources: inventory.resources,
        metricSamples: [],
        warnings: inventory.warnings,
        coverage: {
          inventorySource: inventory.source,
          inventoryImplemented: true,
          resources: inventory.resources.length,
        },
      };
    }

    if (job.sourceType !== 'TECHNICAL_METRIC') {
      return emptyAwsIngestionResult(0, [`Unsupported AWS ingestion source ${job.sourceType}`], {});
    }

    return collectAwsTechnicalMetrics(job, {
      assumeRole: (credential, region) => this.assumeRole(credential, region),
      createCloudWatchClient: (region, credentials) => this.createCloudWatchClient(region, credentials),
    });
  }

    private async assumeRole(
    credential: NonNullable<ReturnType<typeof getCredential>>,
    region: string,
  ): Promise<AwsCredentialIdentity> {
    const roleArn = requireString(credential.payload['roleArn'], 'AWS roleArn');
    const externalId = optionalString(credential.payload['externalId']);
    const sessionName = optionalString(credential.payload['sessionName']) ?? 'finops-ingestion-worker';
    const client = this.createStsClient(region);
    const response = await client.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: sessionName,
      ...(externalId !== undefined ? { ExternalId: externalId } : {}),
      DurationSeconds: 3600,
    }));

    if (
      response.Credentials?.AccessKeyId === undefined ||
      response.Credentials.SecretAccessKey === undefined ||
      response.Credentials.SessionToken === undefined
    ) {
      throw new Error('AWS STS AssumeRole did not return complete credentials');
    }

    return {
      accessKeyId: response.Credentials.AccessKeyId,
      secretAccessKey: response.Credentials.SecretAccessKey,
      sessionToken: response.Credentials.SessionToken,
    };
  }

  private async validateStorageCapability(
    connection: CloudIngestionConnection,
    credentials: AwsCredentialIdentity,
    defaultRegion: string,
    checkedAt: Date,
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
      await this.createS3Client(region, credentials).send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1,
      }));
      return { message: 'Lectura del almacenamiento FOCUS en S3 disponible.', metadata: { bucket, region } };
    });
  }

private createCloudWatchClient(region: string, credentials: AwsCredentialIdentity): AwsCommandClient<AwsMetricDataResponse> {
return new CloudWatchClient({
region,
credentials,
maxAttempts: 2,
}) as AwsCommandClient<AwsMetricDataResponse>;
}


private createCostExplorerClient(credentials: AwsCredentialIdentity): AwsCommandClient<AwsCostExplorerResponse> {
return new CostExplorerClient({ region: 'us-east-1', credentials, maxAttempts: 2 }) as AwsCommandClient<AwsCostExplorerResponse>;
}

private createIdentityClient(
region: string,
credentials: AwsCredentialIdentity,
): AwsCommandClient<AwsCallerIdentityResponse> {
return new STSClient({ region, credentials, maxAttempts: 2 }) as AwsCommandClient<AwsCallerIdentityResponse>;
}

private createEc2Client(
region: string,
credentials: AwsCredentialIdentity,
): AwsCommandClient<AwsDescribeInstancesResponse> {
return new EC2Client({
region,
credentials,
maxAttempts: 2,
}) as AwsCommandClient<AwsDescribeInstancesResponse>;
}

private createS3Client(
region: string,
credentials: AwsCredentialIdentity,
): AwsCommandClient<AwsGetObjectResponse & AwsListObjectsResponse> {
    return new S3Client({
      region,
      credentials,
      maxAttempts: 2,
    }) as AwsCommandClient<AwsGetObjectResponse & AwsListObjectsResponse>;
  }

private createStsClient(region: string): AwsCommandClient<AwsAssumeRoleResponse> {
return new STSClient({ region, maxAttempts: 2 }) as AwsCommandClient<AwsAssumeRoleResponse>;
}

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

function buildAwsPreviewJob(connection: CloudIngestionConnection): CloudIngestionJobContext {
  const targetEnd = new Date();
  return {
    id: `focus-preview-${connection.id}`,
    tenantId: connection.tenantId,
    cloudConnectionId: connection.id,
    sourceType: 'BILLING_EXPORT',
    targetStart: new Date(targetEnd.getTime() - 24 * 60 * 60 * 1000),
    targetEnd,
    attempt: 0,
    connection,
  };
}

function buildFocusPreviewResult(
  providerCode: 'aws',
  configuredLocations: number,
  configuredObjects: number,
  discoveredObjects: number,
  objects: FocusSourcePreviewResult['objects'],
  errors: readonly string[],
): FocusSourcePreviewResult {
  const dates = objects.flatMap((object) => object.lastModified === undefined ? [] : [object.lastModified]);
  return {
    providerCode,
    configuredLocations,
    configuredObjects,
    discoveredObjects,
    approximateBytes: objects.reduce((sum, object) => sum + (object.sizeBytes ?? 0), 0),
    sizedObjects: objects.filter((object) => object.sizeBytes !== undefined).length,
    supportedFormats: ['csv', 'csv.gz'],
    errors,
    ...(dates.length > 0 ? {
      earliestObjectAt: new Date(Math.min(...dates.map((date) => date.getTime()))),
      latestObjectAt: new Date(Math.max(...dates.map((date) => date.getTime()))),
    } : {}),
    objects,
  };
}
