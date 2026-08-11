import { describe, expect, it } from 'vitest';
import {
  buildMetricSeriesCursor,
  mapMetricSeriesRow,
  parseMetricSeriesCursor,
} from './technicalMetricQueryHelpers.js';

describe('technical metric query helpers', () => {
  it('round-trips the compound metric series cursor', () => {
    const bucketStart = new Date('2026-08-11T12:00:00.000Z');
    const cursor = buildMetricSeriesCursor({
      bucket_start: bucketStart,
      external_resource_id: 'ocid1.instance|demo',
      cloud_resource_id: 'resource-1',
      metric_name: 'CpuUtilization',
      metric_unit: '%',
      avg_value: 42,
      min_value: 10,
      max_value: 80,
      latest_value: 50,
      sample_count: 4,
      min_sampled_at: bucketStart,
      max_sampled_at: bucketStart,
      latest_sampled_at: bucketStart,
    });

    expect(parseMetricSeriesCursor(cursor)).toEqual({
      kind: 'compound',
      bucketStart,
      externalResourceId: 'ocid1.instance|demo',
      cloudResourceId: 'resource-1',
      metricName: 'CpuUtilization',
    });
  });

  it('keeps backwards compatibility with legacy date cursors', () => {
    const cursor = parseMetricSeriesCursor('2026-08-11T12:00:00.000Z');

    expect(cursor).toEqual({
      kind: 'legacy-date',
      bucketStart: new Date('2026-08-11T12:00:00.000Z'),
      externalResourceId: '',
      cloudResourceId: '',
      metricName: '',
    });
  });

  it('maps SQL rows without exposing database column names', () => {
    const sampledAt = new Date('2026-08-11T12:00:00.000Z');

    expect(mapMetricSeriesRow({
      bucket_start: sampledAt,
      external_resource_id: 'resource-1',
      cloud_resource_id: null,
      metric_name: 'CpuUtilization',
      metric_unit: '%',
      avg_value: 42.12345,
      min_value: 10.1,
      max_value: 80.9876,
      latest_value: 50.5555,
      sample_count: 4,
      min_sampled_at: sampledAt,
      max_sampled_at: sampledAt,
      latest_sampled_at: sampledAt,
    })).toEqual({
      bucketStart: sampledAt,
      externalResourceId: 'resource-1',
      metricName: 'CpuUtilization',
      metricUnit: '%',
      avg: 42.123,
      min: 10.1,
      max: 80.988,
      latest: 50.556,
      sampleCount: 4,
      minSampledAt: sampledAt,
      maxSampledAt: sampledAt,
      latestSampledAt: sampledAt,
    });
  });
});
