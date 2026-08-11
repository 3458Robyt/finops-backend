import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import type { AwsCredentialIdentity } from '@smithy/types';
import type {
  CloudIngestionJobContext,
  NormalizedCloudResource,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { getCredential, optionalString, readObjectArray, requireString } from '../providerConfig.js';
import type { AwsCommandClient, AwsDescribeInstancesResponse } from './awsContracts.js';
import {
  awsTagsToRecord,
  inferAwsResourceType,
  inferAwsServiceName,
  mergeAwsInventoryResources,
  normalizeAwsResourceStatus,
  readAwsInventoryRegions,
  readAwsMetricDefinitions,
  safeAwsProviderError,
} from './awsConfiguration.js';

export interface AwsInventoryCollection {
  readonly apiCallCount: number;
  readonly resources: readonly NormalizedCloudResource[];
  readonly warnings: readonly string[];
  readonly source: string;
}

interface AwsInventoryCollectorDependencies {
  readonly assumeRole: (
    credential: NonNullable<ReturnType<typeof getCredential>>,
    region: string,
  ) => Promise<AwsCredentialIdentity>;
  readonly createEc2Client: (
    region: string,
    credentials: AwsCredentialIdentity,
  ) => AwsCommandClient<AwsDescribeInstancesResponse>;
}

export async function collectAwsInventory(
  job: CloudIngestionJobContext,
  dependencies: AwsInventoryCollectorDependencies,
): Promise<AwsInventoryCollection> {
  const explicit = readExplicitResources(job);
  const defaultRegion = job.connection.defaultRegion ?? 'us-east-1';
  const inferred = readAwsMetricDefinitions(job).map((definition): NormalizedCloudResource => ({
    tenantId: job.tenantId,
    cloudConnectionId: job.cloudConnectionId,
    provider: 'AWS',
    externalResourceId: definition.externalResourceId,
    name: definition.externalResourceId,
    resourceType: inferAwsResourceType(definition),
    serviceName: inferAwsServiceName(definition),
    regionId: definition.region ?? defaultRegion,
    status: 'UNKNOWN',
    rawResource: {
      source: 'AWS_METRIC_DEFINITION',
      namespace: definition.namespace,
      metricName: definition.metricName,
      dimensions: definition.dimensions,
    },
  }));

  let sdkResources: readonly NormalizedCloudResource[] = [];
  let apiCallCount = 0;
  const warnings: string[] = [];
  try {
    const credential = getCredential(job.connection.credentials, ['INVENTORY_READ', 'OPERATIONAL']);
    if (credential === undefined) {
      warnings.push('AWS inventory SDK skipped: missing INVENTORY_READ or OPERATIONAL credential.');
    } else {
      const assumed = await dependencies.assumeRole(credential, defaultRegion);
      const inventory = await collectEc2Resources(job, assumed, defaultRegion, dependencies.createEc2Client);
      sdkResources = inventory.resources;
      apiCallCount = inventory.apiCallCount + 1;
    }
  } catch (error) {
    warnings.push(`AWS inventory SDK skipped: ${safeAwsProviderError(error)}`);
  }

  const resources = mergeAwsInventoryResources([...inferred, ...explicit, ...sdkResources]);
  if (resources.length === 0) {
    warnings.push('No AWS inventory resources found from EC2 SDK, metadata or CloudWatch metric definitions.');
  }
  return {
    apiCallCount,
    resources,
    warnings,
    source: sdkResources.length > 0 ? 'aws_ec2_sdk_with_metadata_fallback' : 'metadata_and_metric_definitions',
  };
}

function readExplicitResources(job: CloudIngestionJobContext): readonly NormalizedCloudResource[] {
  return readObjectArray(job.connection.metadata, 'awsInventoryResources').map((item) => {
    const externalResourceId = requireString(item['externalResourceId'], 'awsInventoryResources.externalResourceId');
    const regionId = optionalString(item['regionId']) ?? optionalString(item['region']) ?? job.connection.defaultRegion;
    return {
      tenantId: job.tenantId,
      cloudConnectionId: job.cloudConnectionId,
      provider: 'AWS' as const,
      externalResourceId,
      name: optionalString(item['name']) ?? optionalString(item['displayName']) ?? externalResourceId,
      resourceType: optionalString(item['resourceType']) ?? 'COMPUTE_INSTANCE',
      serviceName: optionalString(item['serviceName']) ?? 'Amazon EC2',
      ...(regionId !== undefined ? { regionId } : {}),
      status: normalizeAwsResourceStatus(optionalString(item['status'])),
      rawResource: { source: 'AWS_INVENTORY_METADATA', ...item },
    };
  });
}

async function collectEc2Resources(
  job: CloudIngestionJobContext,
  credentials: AwsCredentialIdentity,
  defaultRegion: string,
  createClient: AwsInventoryCollectorDependencies['createEc2Client'],
): Promise<{ readonly apiCallCount: number; readonly resources: readonly NormalizedCloudResource[] }> {
  const resources: NormalizedCloudResource[] = [];
  let apiCallCount = 0;
  for (const region of readAwsInventoryRegions(job, defaultRegion)) {
    const client = createClient(region, credentials);
    let nextToken: string | undefined;
    do {
      apiCallCount += 1;
      const response = await client.send(new DescribeInstancesCommand({
        ...(nextToken !== undefined ? { NextToken: nextToken } : {}),
      }));
      for (const reservation of response.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          if (instance.InstanceId === undefined) continue;
          const tags = awsTagsToRecord(instance.Tags);
          resources.push({
            tenantId: job.tenantId,
            cloudConnectionId: job.cloudConnectionId,
            provider: 'AWS',
            externalResourceId: instance.InstanceId,
            name: typeof tags['Name'] === 'string' && tags['Name'].trim() !== '' ? tags['Name'] : instance.InstanceId,
            resourceType: 'COMPUTE_INSTANCE',
            serviceName: 'Amazon EC2',
            regionId: region,
            status: normalizeAwsResourceStatus(instance.State?.Name),
            tags,
            rawResource: {
              source: 'AWS_EC2_SDK',
              instanceType: instance.InstanceType,
              state: instance.State?.Name,
              availabilityZone: instance.Placement?.AvailabilityZone,
            },
          });
        }
      }
      nextToken = response.NextToken;
    } while (nextToken !== undefined);
  }
  return { apiCallCount, resources };
}
