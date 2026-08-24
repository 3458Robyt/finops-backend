import { describe, expect, it } from 'vitest';

import {
  buildResourceFreshness,
  classifyResourceEvidenceStatus,
  normalizeExternalResourceId,
  resolveExactResourceLink,
  resourceLookupKey,
} from './ResourceLinkage.js';

describe('ResourceLinkage', () => {
  it('resolves only an exact connection plus external id match', () => {
    const links = new Map([
      [resourceLookupKey('connection-a', 'ocid-1'), ['resource-a']],
      [resourceLookupKey('connection-b', 'ocid-1'), ['resource-b']],
    ]);

    expect(resolveExactResourceLink({
      cloudConnectionId: 'connection-a',
      externalResourceId: ' ocid-1 ',
      resourceIdsByKey: links,
    })).toEqual({ cloudResourceId: 'resource-a' });
    expect(resolveExactResourceLink({
      cloudConnectionId: 'connection-a',
      externalResourceId: 'resource-name',
      resourceIdsByKey: links,
    })).toEqual({ reason: 'INVENTORY_RESOURCE_NOT_FOUND' });
  });

  it('classifies unsafe or non-resource rows without guessing', () => {
    const links = new Map<string, readonly string[]>();

    expect(normalizeExternalResourceId('  ')).toBeUndefined();
    expect(normalizeExternalResourceId('OCID1.INSTANCE.OC1.IAD.Example')).toBe('ocid1.instance.oc1.iad.example');
    expect(normalizeExternalResourceId('MyCaseSensitiveResource')).toBe('MyCaseSensitiveResource');
    expect(resolveExactResourceLink({
      cloudConnectionId: 'connection-a',
      resourceIdsByKey: links,
    })).toEqual({ reason: 'EMPTY_RESOURCE_ID' });
    expect(resolveExactResourceLink({
      cloudConnectionId: 'connection-a',
      resourceIdsByKey: links,
      serviceLevel: true,
    })).toEqual({ reason: 'SERVICE_LEVEL_COST' });
    expect(resolveExactResourceLink({
      externalResourceId: 'ocid-1',
      resourceIdsByKey: links,
    })).toEqual({ reason: 'CONNECTION_NOT_AVAILABLE' });
  });

  it('does not accept ambiguous matches', () => {
    expect(resolveExactResourceLink({
      cloudConnectionId: 'connection-a',
      externalResourceId: 'ocid-1',
      resourceIdsByKey: new Map([[resourceLookupKey('connection-a', 'ocid-1'), ['resource-a', 'resource-b']]]),
    })).toEqual({ reason: 'AMBIGUOUS_RESOURCE_ID' });
  });

  it('classifies evidence freshness and resource readiness explicitly', () => {
    const now = new Date('2026-08-03T12:00:00.000Z');
    const fresh = buildResourceFreshness({
      inventoryAt: new Date('2026-08-03T11:00:00.000Z'),
      costsAt: new Date('2026-08-02T12:00:00.000Z'),
      metricsAt: new Date('2026-08-03T11:30:00.000Z'),
    }, now);
    expect(fresh.inventory.status).toBe('FRESH');
    expect(fresh.costs.status).toBe('FRESH');
    expect(fresh.metrics.status).toBe('FRESH');
    expect(classifyResourceEvidenceStatus({ costCount: 10, metricCount: 5, freshness: fresh })).toBe('EVIDENCE_COMPLETE');

    const stale = buildResourceFreshness({
      inventoryAt: new Date('2026-07-01T12:00:00.000Z'),
      costsAt: new Date('2026-06-01T12:00:00.000Z'),
      metricsAt: new Date('2026-07-01T12:00:00.000Z'),
    }, now);
    expect(stale.inventory.status).toBe('STALE');
    expect(stale.costs.status).toBe('STALE');
    expect(stale.metrics.status).toBe('STALE');
    expect(classifyResourceEvidenceStatus({ costCount: 10, metricCount: 0, freshness: stale })).toBe('STALE_DATA');
    expect(buildResourceFreshness({}).inventory.status).toBe('NO_DATA');
  });
});
