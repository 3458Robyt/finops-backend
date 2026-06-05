import { describe, expect, it } from 'vitest';
import { readBoundedPositiveInteger } from './providerConfig.js';

describe('readBoundedPositiveInteger', () => {
  it('uses the default for non numeric values', () => {
    expect(readBoundedPositiveInteger(undefined, 100, 1, 1000)).toBe(100);
    expect(readBoundedPositiveInteger('10', 100, 1, 1000)).toBe(100);
  });

  it('floors values and clamps to the configured range', () => {
    expect(readBoundedPositiveInteger(10.8, 100, 1, 1000)).toBe(10);
    expect(readBoundedPositiveInteger(-5, 100, 1, 1000)).toBe(1);
    expect(readBoundedPositiveInteger(5000, 100, 1, 1000)).toBe(1000);
  });
});
