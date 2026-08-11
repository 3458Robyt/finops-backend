import type { ResourceTagGovernance } from '../../../domain/interfaces/IResourceLinkageReadinessRepository.js';

export interface TagGovernanceCounts {
  readonly totalResources: number;
  readonly taggedResources: number;
  readonly compliantResources: number;
  readonly missingKeys: Readonly<Record<string, number>>;
}

export function buildTagGovernance(
  requiredKeys: readonly string[],
  counts: TagGovernanceCounts,
): ResourceTagGovernance {
  const totalResources = Math.max(0, counts.totalResources);
  const taggedResources = clamp(counts.taggedResources, 0, totalResources);
  const compliantResources = clamp(counts.compliantResources, 0, totalResources);
  const missingKeys = Object.fromEntries(
    requiredKeys.map((key) => [key, Math.max(0, counts.missingKeys[key] ?? 0)]),
  );

  return {
    requiredKeys: [...requiredKeys],
    totalResources,
    taggedResources,
    compliantResources,
    nonCompliantResources: totalResources - compliantResources,
    untaggedResources: totalResources - taggedResources,
    coveragePercent: totalResources === 0 ? 0 : round((compliantResources / totalResources) * 100),
    missingKeys,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Number.isFinite(value) ? Math.trunc(value) : 0, minimum), maximum);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
