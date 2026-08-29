import { describe, expect, it } from 'vitest';
import type {
  CloudIngestionConnection,
  CloudIngestionCredential,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
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
import {
  validateAwsConnection,
  type AwsConnectionValidationDependencies,
} from './awsConnectionValidator.js';

describe('validateAwsConnection', () => {
  it('confirms the configured role and every requested AWS capability', async () => {
    const destroyedClients: string[] = [];
    const dependencies: AwsConnectionValidationDependencies = {
      assumeRole: async () => ({
        accessKeyId: 'temporary-access-key',
        secretAccessKey: 'temporary-secret',
        sessionToken: 'temporary-session',
      }),
      createIdentityClient: () => fakeClient<AwsCallerIdentityResponse>(
        { Account: '123456789012', Arn: 'arn:aws:sts::123456789012:assumed-role/FinOpsReadOnly/test' },
        destroyedClients,
        'identity',
      ),
      createEc2Client: () => fakeClient<AwsDescribeInstancesResponse>(
        { Reservations: [] },
        destroyedClients,
        'ec2',
      ),
      createCostExplorerClient: () => fakeClient<AwsCostExplorerResponse>(
        { ResultsByTime: [] },
        destroyedClients,
        'cost-explorer',
      ),
      createCloudWatchClient: () => fakeClient<AwsMetricDataResponse & AwsListMetricsResponse>(
        { Metrics: [] },
        destroyedClients,
        'cloudwatch',
      ),
      createS3Client: () => fakeClient<AwsGetObjectResponse & AwsListObjectsResponse>(
        { Contents: [] },
        destroyedClients,
        's3',
      ),
    };

    const result = await validateAwsConnection(buildConnection(), dependencies);

    expect(result.authentication.status).toBe('VERIFIED');
    expect(result.capabilities.map((item) => item.status)).toEqual([
      'AVAILABLE', 'AVAILABLE', 'AVAILABLE', 'AVAILABLE', 'AVAILABLE',
    ]);
    expect(result.capabilities.map((item) => item.capability)).toEqual([
      'IDENTITY', 'INVENTORY', 'COSTS', 'METRICS', 'STORAGE',
    ]);
    expect(destroyedClients).toEqual(['identity', 'ec2', 'cost-explorer', 'cloudwatch', 's3']);
    expect(JSON.stringify(result)).not.toMatch(/temporary-secret|sessionToken/i);
  });
});

function fakeClient<TResponse>(
  response: TResponse,
  destroyedClients: string[],
  name: string,
): AwsCommandClient<TResponse> {
  return {
    send: async () => response,
    destroy: () => destroyedClients.push(name),
  };
}

function buildConnection(): CloudIngestionConnection {
  const credential: CloudIngestionCredential = {
    purpose: 'OPERATIONAL',
    payload: {
      roleArn: 'arn:aws:iam::123456789012:role/FinOpsReadOnly',
      externalId: 'tenant-external-id',
    },
  };

  return {
    id: 'aws-connection-1',
    tenantId: 'tenant-1',
    providerCode: 'aws',
    rootExternalId: '123456789012',
    defaultRegion: 'us-east-1',
    credentials: [credential],
    metadata: {
      awsFocusExportLocations: [{
        bucket: 'finops-billing',
        prefix: 'exports/focus/',
        region: 'us-east-1',
        focusVersion: '1.0',
        maxObjects: 10,
      }],
    },
  };
}
