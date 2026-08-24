/** Canonical outcomes for linking provider data to the normalized inventory. */
export const resourceLinkReasonCodes = [
  'EMPTY_RESOURCE_ID',
  'INVENTORY_RESOURCE_NOT_FOUND',
  'CONNECTION_NOT_AVAILABLE',
  'AMBIGUOUS_RESOURCE_ID',
  'SERVICE_LEVEL_COST',
  'INVALID_EXISTING_REFERENCE',
  'UNSUPPORTED_RESOURCE_ID',
] as const;

export type ResourceLinkReasonCode = (typeof resourceLinkReasonCodes)[number];

export type ResourceEvidenceStatus =
  | 'EVIDENCE_COMPLETE'
  | 'COST_ONLY'
  | 'TECHNICAL_ONLY'
  | 'INSUFFICIENT_EVIDENCE'
  | 'STALE_DATA';

export type ResourceFreshnessStatus = 'FRESH' | 'STALE' | 'NO_DATA';

export interface ResourceFreshnessSignal {
  readonly status: ResourceFreshnessStatus;
  readonly observedAt?: Date;
}

export interface ResourceFreshness {
  readonly inventory: ResourceFreshnessSignal;
  readonly costs: ResourceFreshnessSignal;
  readonly metrics: ResourceFreshnessSignal;
}

export const resourceFreshnessWindowsMs = {
  inventory: 48 * 60 * 60 * 1000,
  costs: 45 * 24 * 60 * 60 * 1000,
  metrics: 48 * 60 * 60 * 1000,
} as const;

export function buildResourceFreshness(input: {
  readonly inventoryAt?: Date | null;
  readonly costsAt?: Date | null;
  readonly metricsAt?: Date | null;
}, now = new Date()): ResourceFreshness {
  return {
    inventory: classifyFreshness(input.inventoryAt, resourceFreshnessWindowsMs.inventory, now),
    costs: classifyFreshness(input.costsAt, resourceFreshnessWindowsMs.costs, now),
    metrics: classifyFreshness(input.metricsAt, resourceFreshnessWindowsMs.metrics, now),
  };
}

export function classifyResourceEvidenceStatus(input: {
  readonly costCount: number;
  readonly metricCount: number;
  readonly freshness: ResourceFreshness;
}): ResourceEvidenceStatus {
  if (input.costCount === 0 && input.metricCount === 0) {
    return 'INSUFFICIENT_EVIDENCE';
  }
  if (input.freshness.inventory.status === 'STALE'
    || (input.costCount > 0 && input.freshness.costs.status === 'STALE')
    || (input.metricCount > 0 && input.freshness.metrics.status === 'STALE')) {
    return 'STALE_DATA';
  }
  if (input.costCount > 0 && input.metricCount > 0) {
    return 'EVIDENCE_COMPLETE';
  }
  return input.costCount > 0 ? 'COST_ONLY' : 'TECHNICAL_ONLY';
}

export interface ResourceLinkResolution {
  readonly cloudResourceId?: string;
  readonly reason?: ResourceLinkReasonCode;
}

function classifyFreshness(
  observedAt: Date | null | undefined,
  maxAgeMs: number,
  now: Date,
): ResourceFreshnessSignal {
  if (observedAt === undefined || observedAt === null) {
    return { status: 'NO_DATA' };
  }
  return {
    status: now.getTime() - observedAt.getTime() <= maxAgeMs ? 'FRESH' : 'STALE',
    observedAt,
  };
}

export function normalizeExternalResourceId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized === '') return undefined;

  // OCI OCIDs are case-insensitive identifiers. Some Monitoring responses
  // return them in uppercase while Resource Search and Compute return the
  // canonical lowercase form. Normalize only OCIDs; AWS identifiers and
  // provider-specific names must retain their original case.
  return /^ocid1\./i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function resourceLookupKey(cloudConnectionId: string, externalResourceId: string): string {
  return `${cloudConnectionId}\u0000${externalResourceId}`;
}

export function resolveExactResourceLink(input: {
  readonly cloudConnectionId?: string;
  readonly externalResourceId?: unknown;
  readonly resourceIdsByKey: ReadonlyMap<string, readonly string[]>;
  readonly serviceLevel?: boolean;
}): ResourceLinkResolution {
  const externalResourceId = normalizeExternalResourceId(input.externalResourceId);
  if (input.serviceLevel === true) {
    return { reason: 'SERVICE_LEVEL_COST' };
  }
  if (externalResourceId === undefined) {
    return { reason: 'EMPTY_RESOURCE_ID' };
  }
  if (input.cloudConnectionId === undefined || input.cloudConnectionId.trim() === '') {
    return { reason: 'CONNECTION_NOT_AVAILABLE' };
  }

  const matches = input.resourceIdsByKey.get(resourceLookupKey(input.cloudConnectionId, externalResourceId)) ?? [];
  if (matches.length === 0) {
    return { reason: 'INVENTORY_RESOURCE_NOT_FOUND' };
  }
  if (matches.length > 1) {
    return { reason: 'AMBIGUOUS_RESOURCE_ID' };
  }
  const [cloudResourceId] = matches;
  return cloudResourceId === undefined
    ? { reason: 'INVENTORY_RESOURCE_NOT_FOUND' }
    : { cloudResourceId };
}
