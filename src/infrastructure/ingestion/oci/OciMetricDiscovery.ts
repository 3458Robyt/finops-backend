import type { CloudIngestionConnection, CloudIngestionJobContext, MetricStatistic } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { OCI_CORE_METRIC_STATISTICS } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { normalizeExternalResourceId } from '../../../domain/models/ResourceLinkage.js';
import type { OciMetricDefinition, OciMonitoringClient } from './OciSdkContracts.js';

export interface OciMetricDiscoveryResult {
  readonly definitions: readonly OciMetricDefinition[];
  readonly regions: readonly string[];
  readonly compartments: readonly string[];
  readonly apiCallCount: number;
  readonly warnings: readonly string[];
}

export interface OciMetricDiscoveryDependencies {
  readonly createClient: (job: CloudIngestionJobContext) => OciMonitoringClient;
  readonly discoverRegions: (job: CloudIngestionJobContext) => Promise<{ readonly regions: readonly string[]; readonly apiCallCount: number; readonly warnings?: readonly string[] }>;
  readonly discoverCompartments: (job: CloudIngestionJobContext) => Promise<{ readonly compartmentIds: readonly string[]; readonly apiCallCount: number; readonly status: string }>;
  readonly withRetry: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly withRateLimit?: <T>(operation: () => Promise<T>) => Promise<T>;
}

/** Discovers provider metric streams without enabling them for ingestion. */
export async function discoverOciMetricDefinitions(
  connection: CloudIngestionConnection,
  dependencies: OciMetricDiscoveryDependencies,
): Promise<OciMetricDiscoveryResult> {
  const baseJob = buildDiscoveryJob(connection);
  const regionDiscovery = await dependencies.discoverRegions(baseJob);
  const regions = regionDiscovery.regions.length > 0
    ? regionDiscovery.regions
    : [connection.defaultRegion ?? 'sa-bogota-1'];
  const compartmentDiscovery = await dependencies.discoverCompartments(baseJob);
  const compartments = compartmentDiscovery.compartmentIds;
  const namespaces = readNamespaces(connection.metadata);
  const definitions = new Map<string, OciMetricDefinition>();
  const warnings: string[] = [...(regionDiscovery.warnings ?? [])];
  let apiCallCount = regionDiscovery.apiCallCount + compartmentDiscovery.apiCallCount;

  for (const regionId of regions) {
    const job = withRegion(baseJob, regionId);
    const client = dependencies.createClient(job);
    try {
      for (const compartmentId of compartments) {
        if (namespaces.length === 1 && namespaces[0] === undefined) {
          const discoveredNamespaces = new Set<string>();
          await readMetricPages(
            client,
            compartmentId,
            undefined,
            regionId,
            warnings,
            apiCallCountRef(() => { apiCallCount += 1; }),
            dependencies,
            (stream) => {
              const discoveredNamespace = stream.namespace?.trim();
              if (discoveredNamespace !== undefined && discoveredNamespace.length > 0) {
                discoveredNamespaces.add(discoveredNamespace);
              }
            },
            true,
          );

          for (const namespace of discoveredNamespaces) {
            await readMetricPages(
              client,
              compartmentId,
              namespace,
              regionId,
              warnings,
              apiCallCountRef(() => { apiCallCount += 1; }),
              dependencies,
              (stream) => addDefinition(stream, compartmentId, regionId, namespace, definitions),
              false,
            );
          }
          continue;
        }

        for (const namespace of namespaces) {
          await readMetricPages(
            client,
            compartmentId,
            namespace,
            regionId,
            warnings,
            apiCallCountRef(() => { apiCallCount += 1; }),
            dependencies,
            (stream) => addDefinition(stream, compartmentId, regionId, namespace, definitions),
            false,
          );
        }
      }
    } finally {
      client.close?.();
    }
  }

  if (compartmentDiscovery.status !== 'COMPLETE') {
    warnings.push('El descubrimiento de compartimentos OCI no fue completo; las definiciones deben revisarse antes de confirmar el backfill.');
  }
  return {
    definitions: [...definitions.values()],
    regions,
    compartments,
    apiCallCount,
    warnings,
  };
}

type ApiCallCounter = () => void;

function apiCallCountRef(increment: ApiCallCounter): ApiCallCounter {
  return increment;
}

async function readMetricPages(
  client: OciMonitoringClient,
  compartmentId: string,
  namespace: string | undefined,
  regionId: string,
  warnings: string[],
  incrementApiCall: ApiCallCounter,
  dependencies: OciMetricDiscoveryDependencies,
  onStream: (stream: NonNullable<Awaited<ReturnType<OciMonitoringClient['listMetrics']>>['items']>[number]) => void,
  groupByNamespace: boolean,
): Promise<void> {
  let page: string | undefined;
  do {
    incrementApiCall();
    try {
      const request = {
        compartmentId,
        listMetricsDetails: groupByNamespace
          ? { groupBy: ['namespace'] }
          : { ...(namespace === undefined ? {} : { namespace }) },
        limit: 1000,
        ...(page === undefined ? {} : { page }),
      };
      const operation = () => dependencies.withRetry(() => client.listMetrics(request));
      const response = dependencies.withRateLimit === undefined
        ? await operation()
        : await dependencies.withRateLimit(operation);
      for (const stream of response.items ?? []) onStream(stream);
      page = response.opcNextPage;
    } catch (error) {
      const namespaceLabel = groupByNamespace ? 'namespaces' : (namespace ?? 'namespace desconocido');
      warnings.push(`No fue posible descubrir métricas OCI en ${regionId}/${compartmentId}/${namespaceLabel}: ${safeMessage(error)}`);
      page = undefined;
    }
  } while (page !== undefined && page.length > 0);
}

function addDefinition(
  stream: NonNullable<Awaited<ReturnType<OciMonitoringClient['listMetrics']>>['items']>[number],
  fallbackCompartmentId: string,
  regionId: string,
  fallbackNamespace: string | undefined,
  definitions: Map<string, OciMetricDefinition>,
): void {
  const metricName = stream.name?.trim();
  if (metricName === undefined || metricName.length === 0) return;
  const dimensions = normalizeDimensions(stream.dimensions);
  const externalResourceId = dimensions['resourceId'] ?? dimensions['resource_id'] ?? '';
  const discoveredNamespace = stream.namespace?.trim() || fallbackNamespace;
  if (discoveredNamespace === undefined) return;
  const definition: OciMetricDefinition = {
    compartmentId: stream.compartmentId ?? fallbackCompartmentId,
    namespace: discoveredNamespace,
    metricName,
    resourceId: externalResourceId,
    regionId,
    ...(Object.keys(dimensions).length === 0 ? {} : { dimensions }),
    statistics: [...OCI_CORE_METRIC_STATISTICS] as readonly MetricStatistic[],
    ...(stream.unit === undefined ? {} : { unit: stream.unit }),
  };
  definitions.set(definitionKey(definition), definition);
}

function normalizeDimensions(
  dimensions: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (dimensions === undefined) return {};
  const normalized = { ...dimensions };
  for (const key of ['resourceId', 'resource_id']) {
    const resourceId = normalized[key];
    const canonical = normalizeExternalResourceId(resourceId);
    if (canonical !== undefined) normalized[key] = canonical;
  }
  return normalized;
}

function buildDiscoveryJob(connection: CloudIngestionConnection): CloudIngestionJobContext {
  const targetEnd = new Date();
  return {
    id: `metric-discovery-${connection.id}`,
    tenantId: connection.tenantId,
    cloudConnectionId: connection.id,
    sourceType: 'TECHNICAL_METRIC',
    targetStart: new Date(targetEnd.getTime() - 60 * 60 * 1000),
    targetEnd,
    attempt: 0,
    connection,
  };
}

function withRegion(job: CloudIngestionJobContext, regionId: string): CloudIngestionJobContext {
  return { ...job, requestContext: { ...(job.requestContext ?? {}), regionId } };
}

function readNamespaces(metadata: Readonly<Record<string, unknown>> | undefined): readonly (string | undefined)[] {
  const configured = metadata?.['ociMetricNamespaces'];
  if (Array.isArray(configured)) {
    const values = configured.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim());
    if (values.length > 0) return [...new Set(values)];
  }
  // OCI listMetrics supports an omitted namespace filter. That is preferable
  // to maintaining a short allow-list because providers add namespaces and
  // services over time. A configured list remains available as an explicit
  // cost/rate-control escape hatch.
  return [undefined];
}

function definitionKey(definition: OciMetricDefinition): string {
  return JSON.stringify([
    definition.regionId ?? '',
    definition.compartmentId,
    definition.namespace,
    definition.metricName,
    definition.resourceId,
    definition.dimensions ?? {},
  ]);
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'error no identificado';
}
