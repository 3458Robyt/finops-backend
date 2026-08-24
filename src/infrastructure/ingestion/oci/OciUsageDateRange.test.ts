import { describe, expect, test } from 'vitest';
import { normalizeOciDailyUsageRange } from './OciUsageDateRange.js';

describe('OCI Usage API date ranges', () => {
  test('normalizes a partial range to complete UTC days', () => {
    expect(normalizeOciDailyUsageRange(
      new Date('2026-08-15T13:47:12.456Z'),
      new Date('2026-08-17T18:06:30.682Z'),
    )).toEqual({
      start: new Date('2026-08-15T00:00:00.000Z'),
      end: new Date('2026-08-17T00:00:00.000Z'),
    });
  });

  test('uses the previous complete day when both timestamps fall today', () => {
    expect(normalizeOciDailyUsageRange(
      new Date('2026-08-17T17:55:00.000Z'),
      new Date('2026-08-17T18:00:00.000Z'),
    )).toEqual({
      start: new Date('2026-08-16T00:00:00.000Z'),
      end: new Date('2026-08-17T00:00:00.000Z'),
    });
  });
});
