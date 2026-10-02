import type { CloudIngestionConnection, CloudIngestionJobContext, CloudMetricDiscoveryScope, MetricStatistic } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { OCI_CORE_METRIC_STATISTICS } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { normalizeExternalResourceId } from '../../../domain/models/ResourceLinkage.js';
import type { OciMetricDefinition, OciMonitoringClient } from './OciSdkContracts.js';

export interface OciMetricDiscoveryResult {
  readonly definitions: readonly OciMetricDefinition[];
  readonly regions: readonly string[];
  readonly compartments: readonly string[];
  readonly apiCallCount: number;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

const MAX_API_CALLS = 30;
const MAX_DEFINITIONS = 500;

export interface OciMetricDiscoveryDependencies {
  readonly createClient: (job: CloudIngestionJobContext, signal?: AbortSignal) => OciMonitoringClient;
  readonly withRetry: <T>(operation: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal) => Promise<T>;
  readonly withRateLimit?: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
}

/** Discovers provider metric streams without enabling them for ingestion. */
export async function discoverOciMetricDefinitions(
  connection: CloudIngestionConnection,
  dependencies: OciMetricDiscoveryDependencies,
  scope: CloudMetricDiscoveryScope,
  signal?: AbortSignal,
): Promise<OciMetricDiscoveryResult> {
  const baseJob = buildDiscoveryJob(connection);
  const regionId = scope.regionId.trim();
  const compartmentId = scope.compartmentId.trim();
  if (regionId.length === 0 || compartmentId.length === 0) {
    throw new Error('El descubrimiento OCI requiere región y compartment explícitos.');
  }
  const configuredNamespaces = readNamespaces(connection.metadata);
  const namespaces = scope.namespace?.trim()
    ? [scope.namespace.trim()]
    : configuredNamespaces;
  const definitions = new Map<string, OciMetricDefinition>();
  const warnings: string[] = [];
  const budget = { apiCallCount: 0, truncated: false };

  const job = withRegion(baseJob, regionId);
  const client = dependencies.createClient(job, signal);
  try {
    if (namespaces.length === 1 && namespaces[0] === undefined) {
      const discoveredNamespaces = new Set<string>();
      await readMetricPages(
        client,
        compartmentId,
        undefined,
        regionId,
        warnings,
        budget,
        dependencies,
        signal,
        (stream) => {
          const discoveredNamespace = stream.namespace?.trim();
          if (discoveredNamespace !== undefined && discoveredNamespace.length > 0) {
            discoveredNamespaces.add(discoveredNamespace);
          }
        },
        true,
      );

      for (const namespace of discoveredNamespaces) {
        if (budget.truncated) break;
        await readMetricPages(
          client,
          compartmentId,
          namespace,
          regionId,
          warnings,
          budget,
          dependencies,
          signal,
          (stream) => addBoundedDefinition(stream, compartmentId, regionId, namespace, definitions, budget),
          false,
        );
      }
    } else {
      for (const namespace of namespaces) {
        if (budget.truncated) break;
        await readMetricPages(
          client,
          compartmentId,
          namespace,
          regionId,
          warnings,
          budget,
          dependencies,
          signal,
          (stream) => addBoundedDefinition(stream, compartmentId, regionId, namespace, definitions, budget),
          false,
        );
      }
    }
  } finally {
    client.close?.();
  }

  if (budget.truncated) {
    warnings.push(`El descubrimiento alcanzó su límite seguro (${MAX_API_CALLS} llamadas o ${MAX_DEFINITIONS} definiciones); reduce el scope o especifica un namespace y vuelve a consultar.`);
  }
  return {
    definitions: [...definitions.values()],
    regions: [regionId],
    compartments: [compartmentId],
    apiCallCount: budget.apiCallCount,
    truncated: budget.truncated,
    warnings,
  };
}

type DiscoveryBudget = { apiCallCount: number; truncated: boolean };

async function readMetricPages(
  client: OciMonitoringClient,
  compartmentId: string,
  namespace: string | undefined,
  regionId: string,
  warnings: string[],
  budget: DiscoveryBudget,
  dependencies: OciMetricDiscoveryDependencies,
  signal: AbortSignal | undefined,
  onStream: (stream: NonNullable<Awaited<ReturnType<OciMonitoringClient['listMetrics']>>['items']>[number]) => void,
  groupByNamespace: boolean,
): Promise<void> {
  let page: string | undefined;
  do {
    if (budget.apiCallCount >= MAX_API_CALLS) {
      budget.truncated = true;
      return;
    }
    try {
      const request = {
        compartmentId,
        listMetricsDetails: groupByNamespace
          ? { groupBy: ['namespace'] }
          : { ...(namespace === undefined ? {} : { namespace }) },
        limit: 1000,
        ...(page === undefined ? {} : { page }),
      };
      const response = await dependencies.withRetry((attemptSignal) => {
        if (budget.apiCallCount >= MAX_API_CALLS) {
          budget.truncated = true;
          throw new Error('OCI metric discovery call budget exhausted.');
        }
        budget.apiCallCount += 1;
        const requestCall = () => client.listMetrics(request);
        return dependencies.withRateLimit === undefined
          ? requestCall()
          : dependencies.withRateLimit(requestCall, attemptSignal ?? signal);
      }, signal);
      for (const stream of response.items ?? []) {
        onStream(stream);
        if (budget.truncated) return;
      }
      page = response.opcNextPage;
    } catch (error) {
      if (budget.truncated) return;
      if (signal?.aborted === true) throw error;
      const namespaceLabel = groupByNamespace ? 'namespaces' : (namespace ?? 'namespace desconocido');
      warnings.push(`No fue posible descubrir métricas OCI en ${regionId}/${namespaceLabel}: ${safeMessage(error)}`);
      page = undefined;
    }
  } while (page !== undefined && page.length > 0);
}

function addBoundedDefinition(
  stream: NonNullable<Awaited<ReturnType<OciMonitoringClient['listMetrics']>>['items']>[number],
  fallbackCompartmentId: string,
  regionId: string,
  fallbackNamespace: string | undefined,
  definitions: Map<string, OciMetricDefinition>,
  budget: DiscoveryBudget,
): void {
  const definition = createDefinition(stream, fallbackCompartmentId, regionId, fallbackNamespace);
  if (definition === undefined) return;
  const key = definitionKey(definition);
  if (!definitions.has(key) && definitions.size >= MAX_DEFINITIONS) {
    budget.truncated = true;
    return;
  }
  definitions.set(key, definition);
}

function createDefinition(
  stream: NonNullable<Awaited<ReturnType<OciMonitoringClient['listMetrics']>>['items']>[number],
  fallbackCompartmentId: string,
  regionId: string,
  fallbackNamespace: string | undefined,
): OciMetricDefinition | undefined {
  const metricName = stream.name?.trim();
  if (metricName === undefined || metricName.length === 0) return undefined;
  const dimensions = normalizeDimensions(stream.dimensions);
  const externalResourceId = dimensions['resourceId'] ?? dimensions['resource_id'] ?? '';
  const discoveredNamespace = stream.namespace?.trim() || fallbackNamespace;
  if (discoveredNamespace === undefined) return undefined;
  return {
    compartmentId: stream.compartmentId ?? fallbackCompartmentId,
    namespace: discoveredNamespace,
    metricName,
    resourceId: externalResourceId,
    regionId,
    ...(Object.keys(dimensions).length === 0 ? {} : { dimensions }),
    statistics: [...OCI_CORE_METRIC_STATISTICS] as readonly MetricStatistic[],
    ...(stream.unit === undefined ? {} : { unit: stream.unit }),
  };
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
