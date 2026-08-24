import * as common from 'oci-common';
import * as usageapi from 'oci-usageapi';
import type {
  CloudAuthenticationValidation,
  CloudCapabilityValidation,
  CloudConnectionValidationResult,
  CloudIngestionConnection,
  CloudIngestionJobContext,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { getCredential, requireString } from '../providerConfig.js';
import { buildOciResourceMetricQuery, readOciMetricDefinitions } from './OciMonitoringCollector.js';
import { normalizeOciDailyUsageRange } from './OciUsageDateRange.js';
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
  readonly createIdentityClient: (provider: common.AuthenticationDetailsProvider, signal?: AbortSignal) => OciIdentityClient;
  readonly createComputeClient: (job: CloudIngestionJobContext, signal?: AbortSignal) => OciComputeClient;
  readonly createMonitoringClient: (job: CloudIngestionJobContext, signal?: AbortSignal) => OciMonitoringClient;
  readonly validateStorage: (
    connection: CloudIngestionConnection,
    job: CloudIngestionJobContext,
    checkedAt: Date,
    signal?: AbortSignal,
  ) => Promise<CloudCapabilityValidation>;
}

const OCI_VALIDATION_DEADLINE_MS = 18_000;

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
      authentication: {
        status: 'NOT_CONFIGURED',
        message: 'No hay una credencial OCI de lectura para autenticar la conexión.',
        checkedAt,
      },
      capabilities: missingCredentialCapabilities(checkedAt),
    };
  }

  const validationController = new AbortController();
  const validationTimer = setTimeout(
    () => validationController.abort(new Error('OCI capability validation deadline exceeded')),
    OCI_VALIDATION_DEADLINE_MS,
  );

  try {
    const job = buildOciValidationJob(connection);
    let authProvider: common.AuthenticationDetailsProvider;
    try {
      authProvider = dependencies.createAuthProvider(job);
    } catch (error) {
      const failure = failedOciCapability('IDENTITY', error, checkedAt);
      return {
        providerCode: dependencies.providerCode,
        authentication: {
          status: 'REJECTED',
          message: 'La credencial OCI no pudo construir una autenticación válida. Revisa el par de clave y el fingerprint.',
          checkedAt,
        },
        capabilities: [
          failure,
          ...blockedCapabilities(checkedAt, 'La autenticación OCI fue rechazada; esta capacidad no se consultó.'),
        ],
      };
    }

  const userId = requireString(credential.payload['userId'], 'OCI userId');
  const identity = await validateOciCall('IDENTITY', checkedAt, () => withOciClient(
    dependencies.createIdentityClient(authProvider, validationController.signal),
    async (client) => {
      await client.getUser({ userId });
      return { message: 'Firma OCI e identidad de usuario validadas.', metadata: { userId } };
    },
  ));

  const authentication = authenticationFromIdentity(identity, checkedAt);
  if (authentication.status !== 'VERIFIED') {
    return {
      providerCode: dependencies.providerCode,
      authentication,
      capabilities: [
        identity,
        ...blockedCapabilities(checkedAt, authentication.message),
      ],
    };
  }

  const [inventory, costs, metrics, storage] = await Promise.all([
    validateOciCall('INVENTORY', checkedAt, () => withOciClient(
    dependencies.createComputeClient(job, validationController.signal),
    async (client) => {
      await client.listInstances({ compartmentId: connection.rootExternalId, limit: 1 });
      return { message: 'Lectura de inventario OCI Compute disponible.' };
    },
    )),
    validateOciCall('COSTS', checkedAt, () => withOciClient(
    new usageapi.UsageapiClient(
      { authenticationDetailsProvider: authProvider },
      {
        circuitBreaker: new common.CircuitBreaker({ disableClientCircuitBreaker: true }),
        httpOptions: { signal: validationController.signal },
      },
    ) as unknown as OciUsageClient,
    async (client) => {
      const end = new Date();
      const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
      const range = normalizeOciDailyUsageRange(start, end);
      await client.requestSummarizedUsages({
        requestSummarizedUsagesDetails: {
          tenantId: connection.rootExternalId,
          timeUsageStarted: range.start,
          timeUsageEnded: range.end,
          granularity: 'DAILY',
          queryType: 'COST',
        },
      });
      return { message: 'OCI Usage API disponible.' };
    },
    )),
    validateOciCall('METRICS', checkedAt, () => withOciClient(
    dependencies.createMonitoringClient(job, validationController.signal),
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
    )),
    dependencies.validateStorage(connection, job, checkedAt, validationController.signal),
  ]);
    return {
      providerCode: dependencies.providerCode,
      authentication,
      capabilities: [identity, inventory, costs, metrics, storage],
    };
  } finally {
    clearTimeout(validationTimer);
  }
}

function authenticationFromIdentity(
  identity: CloudCapabilityValidation,
  checkedAt: Date,
): CloudAuthenticationValidation {
  if (identity.status === 'AVAILABLE') {
    return {
      status: 'VERIFIED',
      message: 'La firma OCI fue aceptada por el proveedor.',
      checkedAt,
    };
  }

  const reasonCode = identity.metadata?.['reasonCode'];
  if (identity.status === 'DENIED' && reasonCode === 'AUTHORIZATION_DENIED') {
    return {
      status: 'VERIFIED',
      message: 'La firma OCI fue aceptada, pero la policy no permite consultar la identidad del usuario.',
      checkedAt,
    };
  }

  if (identity.metadata?.['reasonCode'] === 'HTTP_SIGNATURE_REJECTED') {
    return {
      status: 'REJECTED',
      message: 'OCI rechazó la firma HTTP. Verifica que el usuario, tenancy, clave pública y fingerprint pertenezcan al mismo API key.',
      checkedAt,
    };
  }

  return {
    status: 'RETRYABLE_ERROR',
    message: 'OCI no permitió confirmar la autenticación. Revisa la conectividad y vuelve a intentar antes de reemplazar la credencial.',
    checkedAt,
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
  const metadata = providerErrorMetadata(error, message);
  const denied = metadata['reasonCode'] === 'AUTHORIZATION_DENIED'
    || metadata['reasonCode'] === 'HTTP_SIGNATURE_REJECTED';
  return {
    capability,
    status: denied ? 'DENIED' : 'ERROR',
    message: denied
      ? 'OCI rechazó esta lectura. Revisa las policies de solo lectura para la capacidad indicada.'
      : message,
    checkedAt,
    metadata,
  };
}

function blockedCapabilities(
  checkedAt: Date,
  message: string,
): readonly CloudCapabilityValidation[] {
  return (['INVENTORY', 'COSTS', 'METRICS', 'STORAGE'] as const).map((capability) => ({
    capability,
    status: 'BLOCKED' as const,
    message: `No se consultó ${capability.toLowerCase()} porque ${message.toLowerCase()}`,
    checkedAt,
  }));
}

function providerErrorMetadata(
  error: unknown,
  message: string,
): Readonly<Record<string, string | number | boolean>> {
  const candidate = error !== null && typeof error === 'object'
    ? error as Record<string, unknown>
    : {};
  const statusCode = readNumber(candidate['statusCode']) ?? readNumber(candidate['status']);
  const reasonCode = statusCode === 401 || /signature|not authenticated|notauthenticated/i.test(message)
    ? 'HTTP_SIGNATURE_REJECTED'
    : statusCode === 403 || /forbidden|not.?authorized|authorization failed/i.test(message)
      ? 'AUTHORIZATION_DENIED'
      : undefined;
  return {
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(reasonCode === undefined ? {} : { reasonCode }),
  };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
