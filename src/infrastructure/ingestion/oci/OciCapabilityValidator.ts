import type * as common from 'oci-common';
import * as usageapi from 'oci-usageapi';
import type {
  CloudCapabilityValidation,
  CloudConnectionValidationResult,
  CloudIngestionConnection,
  CloudIngestionJobContext,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { getCredential, requireString } from '../providerConfig.js';
import { buildOciResourceMetricQuery, readOciMetricDefinitions } from './OciMonitoringCollector.js';
import type {
  OciComputeClient,
  OciIdentityClient,
  OciMonitoringClient,
  OciUsageClient,
} from './OciSdkContracts.js';
import { safeErrorMessage } from '../../../application/observability/safeError.js';

export interface OciCapabilityValidationDependencies {
  readonly providerCode: string;
  readonly createAuthProvider: (job: CloudIngestionJobContext) => common.AuthenticationDetailsProvider;
  readonly createIdentityClient: (provider: common.AuthenticationDetailsProvider) => OciIdentityClient;
  readonly createComputeClient: (job: CloudIngestionJobContext) => OciComputeClient;
  readonly createMonitoringClient: (job: CloudIngestionJobContext) => OciMonitoringClient;
  readonly validateStorage: (
    connection: CloudIngestionConnection,
    job: CloudIngestionJobContext,
    checkedAt: Date,
  ) => Promise<CloudCapabilityValidation>;
}

export async function validateOciCapabilities(
  connection: CloudIngestionConnection,
  dependencies: OciCapabilityValidationDependencies,
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
      providerCode: dependencies.providerCode,
      capabilities: missingCredentialCapabilities(checkedAt),
    };
  }

  const job = buildOciValidationJob(connection);
  let authProvider: common.AuthenticationDetailsProvider;
  try {
    authProvider = dependencies.createAuthProvider(job);
  } catch (error) {
    const failure = failedOciCapability('IDENTITY', error, checkedAt);
    return {
      providerCode: dependencies.providerCode,
      capabilities: [
        failure,
        ...(['INVENTORY', 'COSTS', 'METRICS', 'STORAGE'] as const).map((capability) => ({
          capability,
          status: failure.status,
          message: 'No se puede comprobar esta capacidad porque la credencial OCI no es válida.',
          checkedAt,
        })),
      ],
    };
  }

  const userId = requireString(credential.payload['userId'], 'OCI userId');
  const identity = await validateOciCall('IDENTITY', checkedAt, () => withOciClient(
    dependencies.createIdentityClient(authProvider),
    async (client) => {
      await client.getUser({ userId });
      return { message: 'Firma OCI e identidad de usuario validadas.', metadata: { userId } };
    },
  ));

  const inventory = await validateOciCall('INVENTORY', checkedAt, () => withOciClient(
    dependencies.createComputeClient(job),
    async (client) => {
      await client.listInstances({ compartmentId: connection.rootExternalId, limit: 1 });
      return { message: 'Lectura de inventario OCI Compute disponible.' };
    },
  ));

  const costs = await validateOciCall('COSTS', checkedAt, () => withOciClient(
    new usageapi.UsageapiClient({ authenticationDetailsProvider: authProvider }) as unknown as OciUsageClient,
    async (client) => {
      const end = new Date();
      const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
      await client.requestSummarizedUsages({
        requestSummarizedUsagesDetails: {
          tenantId: connection.rootExternalId,
          timeUsageStarted: start,
          timeUsageEnded: end,
          granularity: 'DAILY',
          queryType: 'COST',
        },
      });
      return { message: 'OCI Usage API disponible.' };
    },
  ));

  const metrics = await validateOciCall('METRICS', checkedAt, () => withOciClient(
    dependencies.createMonitoringClient(job),
    async (client) => {
      const definition = readOciMetricDefinitions(job)[0];
      if (definition === undefined) {
        await client.listMetrics({
          compartmentId: connection.rootExternalId,
          compartmentIdInSubtree: true,
          listMetricsDetails: { groupBy: ['namespace'] },
          limit: 1,
        });
      } else {
        await client.summarizeMetricsData({
          compartmentId: definition.compartmentId,
          summarizeMetricsDataDetails: {
            namespace: definition.namespace,
            query: definition.query ?? buildOciResourceMetricQuery(definition),
            startTime: new Date(checkedAt.getTime() - 5 * 60 * 1000),
            endTime: checkedAt,
            resolution: '5m',
          },
        });
      }
      return { message: 'Lectura de métricas OCI Monitoring disponible.' };
    },
  ));

  const storage = await dependencies.validateStorage(connection, job, checkedAt);
  return {
    providerCode: dependencies.providerCode,
    capabilities: [identity, inventory, costs, metrics, storage],
  };
}

export function buildOciValidationJob(
  connection: CloudIngestionConnection,
): CloudIngestionJobContext {
  const targetEnd = new Date();
  return {
    id: `validation-${connection.id}`,
    tenantId: connection.tenantId,
    cloudConnectionId: connection.id,
    sourceType: 'INVENTORY',
    targetStart: new Date(targetEnd.getTime() - 24 * 60 * 60 * 1000),
    targetEnd,
    attempt: 0,
    connection,
  };
}

export async function validateOciCall(
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
      ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
    };
  } catch (error) {
    return failedOciCapability(capability, error, checkedAt);
  }
}

export function safeOciProviderError(error: unknown): string {
  return safeErrorMessage(error);
}

export async function withOciClient<TClient extends { close?(): void }, TResult>(
  client: TClient,
  operation: (client: TClient) => Promise<TResult>,
): Promise<TResult> {
  try {
    return await operation(client);
  } finally {
    client.close?.();
  }
}

function failedOciCapability(
  capability: CloudCapabilityValidation['capability'],
  error: unknown,
  checkedAt: Date,
): CloudCapabilityValidation {
  const message = safeOciProviderError(error);
  const denied = /not.?authorized|notauthenticated|authorization failed|forbidden|401|403/i.test(message);
  return {
    capability,
    status: denied ? 'DENIED' : 'ERROR',
    message: denied
      ? 'OCI rechazó esta lectura. Revisa las policies de solo lectura para la capacidad indicada.'
      : message,
    checkedAt,
  };
}

function missingCredentialCapabilities(
  checkedAt: Date,
): readonly CloudCapabilityValidation[] {
  return (['IDENTITY', 'INVENTORY', 'COSTS', 'METRICS', 'STORAGE'] as const).map((capability) => ({
    capability,
    status: 'NOT_CONFIGURED',
    message: 'No hay una credencial OCI de lectura activa.',
    checkedAt,
  }));
}
