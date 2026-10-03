import { ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import type {
  CloudIngestionConnection,
  CloudMetricDefinitionCandidate,
  CloudMetricDiscoveryResult,
  CloudMetricDiscoveryScope,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { getCredential, readStringArray } from '../providerConfig.js';
import { safeErrorMessage } from '../../../application/observability/safeError.js';
import type { AwsCommandClient, AwsListMetricsResponse } from './awsContracts.js';
import { normalizeAwsStatistic, resourceIdFromAwsDimensions } from './AwsMetricCollector.js';
import type { AwsCredentialIdentity } from '@smithy/types';

const MAX_CALLS = 30;
const MAX_DEFINITIONS = 500;

export async function discoverAwsMetricDefinitions(
  connection: CloudIngestionConnection,
  scope: CloudMetricDiscoveryScope,
  dependencies: {
    readonly assumeRole: (credential: NonNullable<ReturnType<typeof getCredential>>, region: string) => Promise<AwsCredentialIdentity>;
    readonly createClient: (region: string, credentials: AwsCredentialIdentity) => AwsCommandClient<AwsListMetricsResponse>;
  },
  signal?: AbortSignal,
): Promise<CloudMetricDiscoveryResult> {
  const credential = getCredential(connection.credentials, ['OPERATIONAL', 'METRICS_READ']);
  if (credential === undefined) throw new Error('No existe una credencial AWS activa para descubrir métricas.');
  const region = scope.regionId;
  const credentials = await dependencies.assumeRole(credential, region);
  const namespaces = scope.namespace === undefined
    ? readStringArray(connection.metadata?.['awsMetricDiscoveryNamespaces'])
    : [scope.namespace];
  const metricNames = readStringArray(connection.metadata?.['awsMetricDiscoveryNames']);
  const statistics = readStringArray(connection.metadata?.['awsMetricDiscoveryStatistics']);
  const targetNamespaces = namespaces.length > 0 ? namespaces : ['AWS/EC2', 'AWS/EBS'];
  const targetMetrics = metricNames.length > 0
    ? metricNames
    : ['CPUUtilization', 'NetworkIn', 'NetworkOut', 'DiskReadBytes', 'DiskWriteBytes', 'StatusCheckFailed', 'VolumeReadOps', 'VolumeWriteOps', 'VolumeIdleTime'];
  const targetStatistics = statistics.length > 0 ? statistics : ['Average'];
  const client = dependencies.createClient(region, credentials);
  const definitions = new Map<string, CloudMetricDefinitionCandidate>();
  const warnings: string[] = [];
  let apiCallCount = 0;
  let truncated = false;
  let skippedWithoutResource = 0;
  try {
    for (const namespace of targetNamespaces) {
      for (const metricName of targetMetrics) {
        let nextToken: string | undefined;
        const seenTokens = new Set<string>();
        do {
          signal?.throwIfAborted();
          if (apiCallCount >= MAX_CALLS) { truncated = true; break; }
          apiCallCount += 1;
          const response = await client.send(new ListMetricsCommand({
            Namespace: namespace,
            MetricName: metricName,
            ...(nextToken === undefined ? {} : { NextToken: nextToken }),
          }), { ...(signal === undefined ? {} : { abortSignal: signal }) });
          for (const metric of response.Metrics ?? []) {
            const resolvedNamespace = metric.Namespace ?? namespace;
            const resolvedName = metric.MetricName ?? metricName;
            const dimensions = Object.fromEntries((metric.Dimensions ?? [])
              .flatMap((item) => item.Name !== undefined && item.Value !== undefined ? [[item.Name, item.Value]] : []));
            const resourceId = resourceIdFromAwsDimensions(Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value })));
            if (resourceId === undefined) {
              skippedWithoutResource += 1;
              continue;
            }
            const candidate: CloudMetricDefinitionCandidate = {
              compartmentId: connection.rootExternalId,
              namespace: resolvedNamespace,
              metricName: resolvedName,
              resourceId,
              regionId: region,
              dimensions,
              statistics: [...new Set(targetStatistics.map(normalizeAwsStatistic))],
              ...(metric.Unit === undefined ? {} : { unit: metric.Unit }),
            };
            const identity = JSON.stringify([candidate.regionId, candidate.namespace, candidate.metricName, candidate.resourceId, dimensions]);
            definitions.set(identity, candidate);
            if (definitions.size >= MAX_DEFINITIONS) { truncated = true; break; }
          }
          if (truncated) break;
          const token = response.NextToken;
          if (token !== undefined && seenTokens.has(token)) {
            warnings.push(`CloudWatch devolvió un cursor repetido al descubrir ${namespace}/${metricName}; se detuvo la paginación.`);
            nextToken = undefined;
          } else {
            if (token !== undefined) seenTokens.add(token);
            nextToken = token;
          }
        } while (nextToken !== undefined);
        if (truncated) break;
      }
      if (truncated) break;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    warnings.push(`CloudWatch no pudo completar el descubrimiento: ${safeErrorMessage(error)}.`);
  } finally {
    client.destroy?.();
  }
  if (skippedWithoutResource > 0) {
    warnings.push(`Se omitieron ${skippedWithoutResource} series CloudWatch sin una dimensión de recurso reconocible; no pueden configurarse de forma segura por recurso.`);
  }
  if (truncated) warnings.push(`Descubrimiento limitado a ${MAX_CALLS} llamadas o ${MAX_DEFINITIONS} definiciones; reduce el namespace o el conjunto de métricas.`);
  return {
    definitions: [...definitions.values()],
    regions: [region],
    compartments: [connection.rootExternalId],
    apiCallCount,
    truncated,
    warnings,
  };
}
