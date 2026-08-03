import { describe, expect, it } from 'vitest';

import {
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
});
