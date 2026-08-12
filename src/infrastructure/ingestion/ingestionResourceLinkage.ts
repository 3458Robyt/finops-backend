import {
  resourceLinkReasonCodes,
  type ResourceLinkReasonCode,
} from '../../domain/models/ResourceLinkage.js';

export interface ResourceLinkageRunStats {
  readonly linked: number;
  readonly unresolved: number;
  readonly reasons: Readonly<Partial<Record<ResourceLinkReasonCode, number>>>;
}

export function emptyResourceLinkageStats(): ResourceLinkageRunStats {
  return { linked: 0, unresolved: 0, reasons: {} };
}

export function summarizeResourceLinkage(
  rows: readonly { readonly cloudResourceId?: string | null; readonly resourceLinkReason?: string | null }[],
): ResourceLinkageRunStats {
  const reasons: Partial<Record<ResourceLinkReasonCode, number>> = {};
  let linked = 0;
  let unresolved = 0;
  for (const row of rows) {
    if (row.cloudResourceId !== undefined && row.cloudResourceId !== null) {
      linked += 1;
      continue;
    }
    unresolved += 1;
    const reason = row.resourceLinkReason ?? undefined;
    if (isResourceLinkReasonCode(reason)) reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return { linked, unresolved, reasons };
}

export function mergeResourceLinkageStats(
  left: ResourceLinkageRunStats,
  right: ResourceLinkageRunStats,
): ResourceLinkageRunStats {
  const reasons: Partial<Record<ResourceLinkReasonCode, number>> = { ...left.reasons };
  for (const [reason, count] of Object.entries(right.reasons)) {
    if (isResourceLinkReasonCode(reason) && count !== undefined) {
      reasons[reason] = (reasons[reason] ?? 0) + count;
    }
  }
  return {
    linked: left.linked + right.linked,
    unresolved: left.unresolved + right.unresolved,
    reasons,
  };
}

function isResourceLinkReasonCode(value: string | undefined): value is ResourceLinkReasonCode {
  return value !== undefined && resourceLinkReasonCodes.includes(value as ResourceLinkReasonCode);
}
