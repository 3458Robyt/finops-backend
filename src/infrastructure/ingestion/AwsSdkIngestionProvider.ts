import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { DescribeRegionsCommand, EC2Client } from '@aws-sdk/client-ec2';
import { S3Client } from '@aws-sdk/client-s3';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { CostExplorerClient } from '@aws-sdk/client-cost-explorer';
import type { AwsCredentialIdentity } from '@smithy/types';
import type {
  CloudIngestionJobContext,
  CloudIngestionConnection,
  CloudConnectionValidationResult,
  CloudIngestionProvider,
  CloudIngestionResult,
  FocusSourcePreviewResult,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import {
  getCredential,
  optionalString,
  requireString,
} from './providerConfig.js';
import type {
  AwsAssumeRoleResponse,
  AwsCallerIdentityResponse,
  AwsCommandClient,
  AwsCostExplorerResponse,
  AwsDescribeInstancesResponse,
  AwsDescribeRegionsResponse,
  AwsDescribeVolumesResponse,
  AwsGetObjectResponse,
  AwsListMetricsResponse,
  AwsListObjectsResponse,
  AwsMetricDataResponse,
} from './aws/awsContracts.js';
import { emptyAwsIngestionResult } from './aws/awsConfiguration.js';
import { collectAwsInventory } from './aws/AwsInventoryCollector.js';
import { collectAwsTechnicalMetrics } from './aws/AwsMetricCollector.js';
import { collectAwsBilling, previewAwsFocus } from './aws/AwsBillingCollector.js';
import { validateAwsConnection } from './aws/awsConnectionValidator.js';

export class AwsSdkIngestionProvider implements CloudIngestionProvider {
  public readonly providerCode = 'aws';

  public async validate(connection: CloudIngestionConnection): Promise<CloudConnectionValidationResult> {
    return validateAwsConnection(connection, {
      assumeRole: (credential, region) => this.assumeRole(credential, region),
      createIdentityClient: (region, credentials) => this.createIdentityClient(region, credentials),
      createEc2Client: (region, credentials) => this.createEc2Client(region, credentials),
      createCostExplorerClient: (credentials) => this.createCostExplorerClient(credentials),
      createCloudWatchClient: (region, credentials) => this.createCloudWatchClient(region, credentials),
      createS3Client: (region, credentials) => this.createS3Client(region, credentials),
    });
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
        discoverRegions: (region, credentials) => this.discoverRegions(region, credentials),
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
    try {
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
    } finally {
      client.destroy?.();
    }
  }

  private createCloudWatchClient(
    region: string,
    credentials: AwsCredentialIdentity,
  ): AwsCommandClient<AwsMetricDataResponse & AwsListMetricsResponse> {
    return new CloudWatchClient({
      region,
      credentials,
      maxAttempts: 2,
    }) as AwsCommandClient<AwsMetricDataResponse & AwsListMetricsResponse>;
  }

  private createCostExplorerClient(
    credentials: AwsCredentialIdentity,
  ): AwsCommandClient<AwsCostExplorerResponse> {
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
  ): AwsCommandClient<AwsDescribeInstancesResponse & AwsDescribeRegionsResponse & AwsDescribeVolumesResponse> {
    return new EC2Client({
      region,
      credentials,
      maxAttempts: 2,
    }) as AwsCommandClient<AwsDescribeInstancesResponse & AwsDescribeRegionsResponse & AwsDescribeVolumesResponse>;
  }

  private async discoverRegions(
    region: string,
    credentials: AwsCredentialIdentity,
  ): Promise<readonly string[]> {
    const client = this.createEc2Client(region, credentials);
    try {
      const response = await client.send(new DescribeRegionsCommand({ AllRegions: false }));
      return (response.Regions ?? [])
        .filter((item) => item.RegionName !== undefined && item.OptInStatus !== 'not-opted-in')
        .map((item) => item.RegionName as string);
    } finally {
      client.destroy?.();
    }
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
