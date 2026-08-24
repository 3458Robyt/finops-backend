import type {
  TechnicalMetricCoverageAggregate,
  TechnicalMetricCoverageSampleItem,
} from '../../../domain/interfaces/IResourceMetricRepository.js';
import type {
  TechnicalMetricCoverage,
  TechnicalMetricCoverageDay,
} from './TechnicalMetricsContracts.js';
import {
  countDays,
  maxDate,
  minDate,
  resourceIdentity,
  round,
  startOfUtcDay,
  toUtcDay,
  unique,
} from './technicalMetricMath.js';

export function buildCoverage(
  samples: readonly TechnicalMetricCoverageSampleItem[],
  requestedStart: Date | undefined,
  requestedEnd: Date | undefined,
): TechnicalMetricCoverage {
  const minSampledAt = minDate(samples.map((sample) => sample.sampledAt));
  const maxSampledAt = maxDate(samples.map((sample) => sample.sampledAt));
  const rangeStart = requestedStart ?? minSampledAt;
  const rangeEnd = requestedEnd ?? maxSampledAt;
  const expectedDays = countDays(rangeStart, rangeEnd);
  const dayBuckets = new Map<string, TechnicalMetricCoverageSampleItem[]>();
  const metricBuckets = new Map<string, TechnicalMetricCoverageSampleItem[]>();

  for (const sample of samples) {
    const day = toUtcDay(sample.sampledAt);
    const daySamples = dayBuckets.get(day) ?? [];
    daySamples.push(sample);
    dayBuckets.set(day, daySamples);

    const metricSamples = metricBuckets.get(sample.metricName) ?? [];
    metricSamples.push(sample);
    metricBuckets.set(sample.metricName, metricSamples);
  }

  const days = buildCoverageDays(rangeStart, rangeEnd, dayBuckets);
  const daysWithData = days.filter((day) => day.status === 'WITH_DATA').length;

  return {
    ...(rangeStart !== undefined ? { rangeStart } : {}),
    ...(rangeEnd !== undefined ? { rangeEnd } : {}),
    ...(minSampledAt !== undefined ? { minSampledAt } : {}),
    ...(maxSampledAt !== undefined ? { maxSampledAt } : {}),
    totalSamples: samples.length,
    metricCount: metricBuckets.size,
    resourceCount: unique(samples.map(resourceIdentity)).length,
    expectedDays,
    daysWithData,
    coveragePercent: expectedDays === 0 ? 0 : round((daysWithData / expectedDays) * 100),
    metrics: [...metricBuckets.entries()].map(([metricName, metricSamples]) => {
      const metricDays = new Set(metricSamples.map((sample) => toUtcDay(sample.sampledAt)));
      const metricMinSampledAt = minDate(metricSamples.map((sample) => sample.sampledAt));
      const metricMaxSampledAt = maxDate(metricSamples.map((sample) => sample.sampledAt));

      return {
        metricName,
        sampleCount: metricSamples.length,
        daysWithData: metricDays.size,
        expectedDays,
        coveragePercent: expectedDays === 0 ? 0 : round((metricDays.size / expectedDays) * 100),
        ...(metricMinSampledAt !== undefined ? { minSampledAt: metricMinSampledAt } : {}),
        ...(metricMaxSampledAt !== undefined ? { maxSampledAt: metricMaxSampledAt } : {}),
      };
    }).sort((left, right) => right.sampleCount - left.sampleCount || left.metricName.localeCompare(right.metricName)),
    days,
  };
}

export function buildCoverageFromAggregate(
  aggregate: TechnicalMetricCoverageAggregate,
  rangeStart: Date | undefined,
  rangeEnd: Date | undefined,
): TechnicalMetricCoverage {
  const effectiveStart = rangeStart ?? aggregate.minSampledAt;
  const effectiveEnd = rangeEnd ?? aggregate.maxSampledAt;
  const expectedDays = countDays(effectiveStart, effectiveEnd);
  const days = buildCoverageDaysFromAggregate(aggregate.days, effectiveStart, effectiveEnd);
  const daysWithData = days.filter((day) => day.status === 'WITH_DATA').length;

  return {
    ...(effectiveStart !== undefined ? { rangeStart: effectiveStart } : {}),
    ...(effectiveEnd !== undefined ? { rangeEnd: effectiveEnd } : {}),
    ...(aggregate.minSampledAt !== undefined ? { minSampledAt: aggregate.minSampledAt } : {}),
    ...(aggregate.maxSampledAt !== undefined ? { maxSampledAt: aggregate.maxSampledAt } : {}),
    totalSamples: aggregate.totalSamples,
    metricCount: aggregate.metricCount,
    resourceCount: aggregate.resourceCount,
    expectedDays,
    daysWithData,
    coveragePercent: expectedDays === 0 ? 0 : round((daysWithData / expectedDays) * 100),
    metrics: aggregate.metrics.map((metric) => ({
      metricName: metric.metricName,
      sampleCount: metric.sampleCount,
      daysWithData: metric.daysWithData,
      expectedDays,
      coveragePercent: expectedDays === 0 ? 0 : round((metric.daysWithData / expectedDays) * 100),
      ...(metric.minSampledAt !== undefined ? { minSampledAt: metric.minSampledAt } : {}),
      ...(metric.maxSampledAt !== undefined ? { maxSampledAt: metric.maxSampledAt } : {}),
    })).sort((left, right) => right.sampleCount - left.sampleCount || left.metricName.localeCompare(right.metricName)),
    days,
  };
}

function buildCoverageDaysFromAggregate(
  aggregateDays: TechnicalMetricCoverageAggregate['days'],
  rangeStart: Date | undefined,
  rangeEnd: Date | undefined,
): readonly TechnicalMetricCoverageDay[] {
  const byDate = new Map(aggregateDays.map((day) => [day.date, day]));
  if (rangeStart === undefined || rangeEnd === undefined) {
    return aggregateDays.map((day) => ({
      ...day,
      status: 'WITH_DATA' as const,
    }));
  }

  const days: TechnicalMetricCoverageDay[] = [];
  const cursor = startOfUtcDay(rangeStart);
  const end = startOfUtcDay(rangeEnd);
  while (cursor.getTime() <= end.getTime()) {
    const date = toUtcDay(cursor);
    const aggregateDay = byDate.get(date);
    days.push({
      date,
      sampleCount: aggregateDay?.sampleCount ?? 0,
      metricCount: aggregateDay?.metricCount ?? 0,
      status: aggregateDay === undefined ? 'NO_DATA' : 'WITH_DATA',
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function buildCoverageDays(
  rangeStart: Date | undefined,
  rangeEnd: Date | undefined,
  dayBuckets: ReadonlyMap<string, readonly TechnicalMetricCoverageSampleItem[]>,
): readonly TechnicalMetricCoverageDay[] {
  if (rangeStart === undefined || rangeEnd === undefined) {
    return [...dayBuckets.entries()].map(([date, daySamples]) => ({
      date,
      sampleCount: daySamples.length,
      metricCount: unique(daySamples.map((sample) => sample.metricName)).length,
      status: 'WITH_DATA' as const,
    })).sort((left, right) => left.date.localeCompare(right.date));
  }

  const days: TechnicalMetricCoverageDay[] = [];
  const cursor = startOfUtcDay(rangeStart);
  const end = startOfUtcDay(rangeEnd);

  while (cursor.getTime() <= end.getTime()) {
    const date = toUtcDay(cursor);
    const daySamples = dayBuckets.get(date) ?? [];
    days.push({
      date,
      sampleCount: daySamples.length,
      metricCount: unique(daySamples.map((sample) => sample.metricName)).length,
      status: daySamples.length > 0 ? 'WITH_DATA' : 'NO_DATA',
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return days;
}
