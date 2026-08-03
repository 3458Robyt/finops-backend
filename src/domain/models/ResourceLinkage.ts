/** Canonical outcomes for linking provider data to the normalized inventory. */
export const resourceLinkReasonCodes = [
  'EMPTY_RESOURCE_ID',
  'INVENTORY_RESOURCE_NOT_FOUND',
  'CONNECTION_NOT_AVAILABLE',
  'AMBIGUOUS_RESOURCE_ID',
  'SERVICE_LEVEL_COST',
  'INVALID_EXISTING_REFERENCE',
] as const;

export type ResourceLinkReasonCode = (typeof resourceLinkReasonCodes)[number];

export interface ResourceLinkResolution {
  readonly cloudResourceId?: string;
  readonly reason?: ResourceLinkReasonCode;
}

export function normalizeExternalResourceId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized === '' ? undefined : normalized;
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
