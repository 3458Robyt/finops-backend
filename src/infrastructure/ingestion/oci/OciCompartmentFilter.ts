import type { CloudIngestionJobContext } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { readStringArray } from '../providerConfig.js';

export interface OciCompartmentFilter {
  readonly includeIds: ReadonlySet<string>;
  readonly excludeIds: ReadonlySet<string>;
}

export function readOciCompartmentFilter(job: CloudIngestionJobContext): OciCompartmentFilter {
  return {
    includeIds: normalizedSet(job.connection.metadata?.['ociInventoryIncludeCompartments']),
    excludeIds: normalizedSet(job.connection.metadata?.['ociInventoryExcludeCompartments']),
  };
}

export function acceptsOciCompartment(filter: OciCompartmentFilter, compartmentId: string): boolean {
  return (filter.includeIds.size === 0 || filter.includeIds.has(compartmentId))
    && !filter.excludeIds.has(compartmentId);
}

export function filterOciCompartmentIds(
  compartmentIds: Iterable<string>,
  filter: OciCompartmentFilter,
): readonly string[] {
  return [...compartmentIds].filter((compartmentId) => acceptsOciCompartment(filter, compartmentId));
}

function normalizedSet(value: unknown): ReadonlySet<string> {
  return new Set(readStringArray(value).map((item) => item.trim()));
}
