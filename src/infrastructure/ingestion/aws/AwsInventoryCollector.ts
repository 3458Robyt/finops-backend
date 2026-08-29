import { DescribeInstancesCommand, DescribeRegionsCommand, DescribeVolumesCommand } from '@aws-sdk/client-ec2';
import type { AwsCredentialIdentity } from '@smithy/types';
import type {
  CloudIngestionJobContext,
  NormalizedCloudResource,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { getCredential, optionalString, readObjectArray, readStringArray, requireString } from '../providerConfig.js';
import type {
  AwsCommandClient,
  AwsDescribeInstancesResponse,
  AwsDescribeRegionsResponse,
  AwsDescribeVolumesResponse,
} from './awsContracts.js';
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
  ) => AwsCommandClient<AwsDescribeInstancesResponse & AwsDescribeRegionsResponse & AwsDescribeVolumesResponse>;
  readonly discoverRegions?: (
    region: string,
    credentials: AwsCredentialIdentity,
  ) => Promise<readonly string[]>;
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
      const inventory = await collectEc2Resources(job, assumed, defaultRegion, dependencies);
      sdkResources = inventory.resources;
      apiCallCount = inventory.apiCallCount + 1;
      warnings.push(...inventory.warnings);
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
  dependencies: AwsInventoryCollectorDependencies,
): Promise<{
  readonly apiCallCount: number;
  readonly resources: readonly NormalizedCloudResource[];
  readonly warnings: readonly string[];
}> {
  const resources: NormalizedCloudResource[] = [];
  const warnings: string[] = [];
  let apiCallCount = 0;
  const resolvedRegions = await resolveInventoryRegions(job, credentials, defaultRegion, dependencies);
  apiCallCount += resolvedRegions.apiCallCount;
  const regions = resolvedRegions.regions;
  for (const region of regions) {
    const client = dependencies.createEc2Client(region, credentials);
    try {
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
    } catch (error) {
      warnings.push(`AWS EC2 no pudo listar instancias en ${region}: ${safeAwsProviderError(error)}`);
    }

    try {
      let volumeNextToken: string | undefined;
      do {
        apiCallCount += 1;
        const response = await client.send(new DescribeVolumesCommand({
          ...(volumeNextToken !== undefined ? { NextToken: volumeNextToken } : {}),
        }));
        for (const volume of response.Volumes ?? []) {
          if (volume.VolumeId === undefined) continue;
          const tags = awsTagsToRecord(volume.Tags);
          resources.push({
            tenantId: job.tenantId,
            cloudConnectionId: job.cloudConnectionId,
            provider: 'AWS',
            externalResourceId: volume.VolumeId,
            name: typeof tags['Name'] === 'string' && tags['Name'].trim() !== '' ? tags['Name'] : volume.VolumeId,
            resourceType: 'BLOCK_VOLUME',
            serviceName: 'Amazon EBS',
            regionId: region,
            status: normalizeAwsResourceStatus(volume.State),
            tags,
            rawResource: {
              source: 'AWS_EBS_SDK',
              volumeType: volume.VolumeType,
              sizeGiB: volume.Size,
              iops: volume.Iops,
              throughputMiBps: volume.Throughput,
              availabilityZone: volume.AvailabilityZone,
              encrypted: volume.Encrypted,
              attachments: volume.Attachments,
            },
          });
        }
        volumeNextToken = response.NextToken;
      } while (volumeNextToken !== undefined);
    } catch (error) {
      warnings.push(`AWS EBS no pudo listar volúmenes en ${region}: ${safeAwsProviderError(error)}`);
    } finally {
      client.destroy?.();
    }
  }
  return { apiCallCount, resources, warnings: [...resolvedRegions.warnings, ...warnings] };
}

async function resolveInventoryRegions(
  job: CloudIngestionJobContext,
  credentials: AwsCredentialIdentity,
  defaultRegion: string,
  dependencies: AwsInventoryCollectorDependencies,
): Promise<{ readonly regions: readonly string[]; readonly apiCallCount: number; readonly warnings: readonly string[] }> {
  const configured = readStringArray(job.connection.metadata?.['awsInventoryRegions']);
  if (configured.length > 0 || dependencies.discoverRegions === undefined) {
    return { regions: readAwsInventoryRegions(job, defaultRegion), apiCallCount: 0, warnings: [] };
  }

  try {
    const discovered = await dependencies.discoverRegions(defaultRegion, credentials);
    const metricRegions = readAwsMetricDefinitions(job)
      .map((definition) => definition.region)
      .filter((region): region is string => region !== undefined);
    return { regions: [...new Set([...discovered, ...metricRegions, defaultRegion])], apiCallCount: 1, warnings: [] };
  } catch (error) {
    return {
      regions: readAwsInventoryRegions(job, defaultRegion),
      apiCallCount: 1,
      warnings: [`AWS no pudo descubrir regiones; se usará la configuración disponible: ${safeAwsProviderError(error)}`],
    };
  }
}
