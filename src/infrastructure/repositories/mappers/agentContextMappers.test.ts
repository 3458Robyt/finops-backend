import { describe, expect, it } from 'vitest';
import { toTrace } from './agentContextMappers.js';

describe('toTrace', () => {
  it('preserves context source identifiers for AI observability', () => {
    const trace = toTrace({
      id: 'trace-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      operation: 'RECOMMENDATION',
      model: 'fixture-model',
      status: 'SUCCESS',
      profileVersion: 2,
      promptTokenEstimate: 120,
      responseTokenEstimate: 80,
      latencyMs: 500,
      artifactIds: ['artifact-1'],
      memoryIds: ['memory-global-1'],
      tenantRuleIds: ['rule-1'],
      conflicts: [],
      createdAt: new Date('2026-08-12T00:00:00.000Z'),
      expiresAt: new Date('2027-02-08T00:00:00.000Z'),
    });

    expect(trace).toMatchObject({
      artifactIds: ['artifact-1'],
      memoryIds: ['memory-global-1'],
      tenantRuleIds: ['rule-1'],
      conflicts: [],
    });
  });

  it('does not expose malformed JSON arrays as trace identifiers', () => {
    const trace = toTrace({
      id: 'trace-2',
      tenantId: 'tenant-1',
      userId: null,
      operation: 'CHAT',
      model: 'fixture-model',
      status: 'SUCCESS',
      profileVersion: null,
      promptTokenEstimate: 10,
      responseTokenEstimate: null,
      latencyMs: null,
      memoryIds: ['memory-1', 42],
      createdAt: new Date('2026-08-12T00:00:00.000Z'),
      expiresAt: new Date('2027-02-08T00:00:00.000Z'),
    });

    expect(trace.memoryIds).toBeUndefined();
  });
});
