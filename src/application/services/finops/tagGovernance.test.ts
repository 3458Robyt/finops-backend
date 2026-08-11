import { describe, expect, it } from 'vitest';
import { buildTagGovernance } from './tagGovernance.js';

describe('buildTagGovernance', () => {
  it('calculates compliance and missing required keys without exceeding resource totals', () => {
    expect(buildTagGovernance(['environment', 'owner'], {
      totalResources: 10,
      taggedResources: 8,
      compliantResources: 6,
      missingKeys: { environment: 3, owner: 1, unexpected: 99 },
    })).toEqual({
      requiredKeys: ['environment', 'owner'],
      totalResources: 10,
      taggedResources: 8,
      compliantResources: 6,
      nonCompliantResources: 4,
      untaggedResources: 2,
      coveragePercent: 60,
      missingKeys: { environment: 3, owner: 1 },
    });
  });

  it('returns zero coverage when no inventory exists', () => {
    expect(buildTagGovernance(['owner'], {
      totalResources: 0,
      taggedResources: 2,
      compliantResources: 2,
      missingKeys: { owner: 0 },
    }).coveragePercent).toBe(0);
  });
});
