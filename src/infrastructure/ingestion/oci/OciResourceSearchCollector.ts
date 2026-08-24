import * as resourcesearch from 'oci-resourcesearch';
import type { AuthenticationDetailsProvider } from 'oci-common';
import type {
  CloudIngestionJobContext,
  NormalizedCloudResource,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { readStringArray } from '../providerConfig.js';
import type {
  OciResourceSearchClient,
} from './OciSdkContracts.js';
import { normalizeOciSearchResource } from './OciResourceNormalizer.js';
import { acceptsOciCompartment, readOciCompartmentFilter } from './OciCompartmentFilter.js';

export function createOciResourceSearchClient(
  authenticationDetailsProvider: AuthenticationDetailsProvider,
): OciResourceSearchClient {
  return new resourcesearch.ResourceSearchClient({
    authenticationDetailsProvider,
  }) as unknown as OciResourceSearchClient;
}

export interface OciResourceSearchCollectionResult {
  readonly apiCallCount: number;
  readonly resources: readonly NormalizedCloudResource[];
  readonly resourceTypes: readonly string[];
  readonly warnings: readonly string[];
  readonly filteredResourceCount: number;
}

export interface OciResourceSearchDependencies {
  readonly createClient: (job: CloudIngestionJobContext) => OciResourceSearchClient;
  readonly withRetry: <T>(operation: () => Promise<T>) => Promise<T>;
}

export async function collectOciResourceSearchInventory(
  job: CloudIngestionJobContext,
  dependencies: OciResourceSearchDependencies,
): Promise<OciResourceSearchCollectionResult> {
  const resourceQuery = resolveResourceQuery(job);
  const client = dependencies.createClient(job);
  const resources: NormalizedCloudResource[] = [];
  const warnings: string[] = [];
  let apiCallCount = 0;
  let filteredResourceCount = 0;
  const compartmentFilter = readOciCompartmentFilter(job);

  try {
    let page: string | undefined;
    do {
      apiCallCount += 1;
      const response = await dependencies.withRetry(() => client.searchResources({
        searchDetails: { type: 'Structured', query: resourceQuery.query },
        limit: 1000,
        ...(page !== undefined ? { page } : {}),
      }));
      for (const summary of response.resourceSummaryCollection?.items ?? []) {
        if (!acceptsOciCompartment(compartmentFilter, summary.compartmentId)) {
          filteredResourceCount += 1;
          continue;
        }
        const resource = normalizeOciSearchResource(job, summary);
        if (resource === undefined) {
          warnings.push(`OCI Resource Search omitió un resultado ${summary.resourceType} sin identificador válido.`);
        } else {
          resources.push(resource);
        }
      }
      page = response.opcNextPage;
    } while (page !== undefined && page !== '');
  } finally {
    client.close?.();
  }

  return {
    apiCallCount,
    resources,
    resourceTypes: resourceQuery.resourceTypes,
    warnings,
    filteredResourceCount,
  };
}

function resolveResourceQuery(job: CloudIngestionJobContext): {
  readonly query: string;
  readonly resourceTypes: readonly string[];
} {
  const configured = readStringArray(job.connection.metadata?.['ociInventoryResourceTypes'])
    .map((value) => value.trim().toLowerCase());
  const resourceTypes = [...new Set(configured.filter((value) => value !== ''))];
  if (resourceTypes.length === 0 || resourceTypes.includes('all')) {
    return { query: 'query all resources', resourceTypes: ['all'] };
  }
  return {
    query: `query ${resourceTypes.join(', ')} resources`,
    resourceTypes,
  };
}
