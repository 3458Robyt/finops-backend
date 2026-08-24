import type { TechnicalMetricSeriesBucket } from '../../../domain/interfaces/IResourceMetricRepository.js';
import type { TechnicalMetricBucket, TechnicalMetricGroup } from './TechnicalMetricsContracts.js';

export function countDays(rangeStart: Date | undefined, rangeEnd: Date | undefined): number {
  if (rangeStart === undefined || rangeEnd === undefined || rangeEnd < rangeStart) {
    return 0;
  }

  const start = startOfUtcDay(rangeStart);
  const end = startOfUtcDay(rangeEnd);
  return Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
}

export function startOfUtcDay(value: Date): Date {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

export function toUtcDay(value: Date): string {
  return startOfUtcDay(value).toISOString().slice(0, 10);
}

export function resolveRequestedBucket(requested: TechnicalMetricBucket): TechnicalMetricSeriesBucket {
  return requested === 'auto' ? 'raw' : requested;
}

export function classifyMetric(metricName: string): TechnicalMetricGroup {
  const normalized = metricName.toLowerCase();

  if (/(^|[^a-z])(cpu|processor|loadaverage|load_avg)([^a-z]|$)/.test(normalized)
    || normalized.includes('cpu')) {
    return 'CPU';
  }
  if (/(memory|mem|ram|swap|pagefile|paging)/.test(normalized)) {
    return 'MEMORY';
  }
  if (/(network|vnic|nic|packet|bandwidth|throughput|rx|tx|receive|transmit)/.test(normalized)) {
    return 'NETWORK';
  }
  if (/(disk|iops|filesystem|file_system|volume|storage|block|read|write|latency)/.test(normalized)) {
    return 'DISK';
  }
  if (/(load|availability|available|uptime|health|status|process|thread|connection)/.test(normalized)) {
    return 'SYSTEM';
  }

  return 'OTHER';
}

export function normalizeUnit(metricName: string, unit: string | undefined): string | undefined {
  if (unit !== undefined) {
    return unit;
  }

  const normalized = metricName.toLowerCase();
  if (normalized.includes('utilization')) {
    return '%';
  }
  if (normalized.includes('bytes')) {
    return 'Bytes';
  }
  if (normalized.includes('iops')) {
    return 'IOPS';
  }

  return undefined;
}

export function minDate(values: readonly Date[]): Date | undefined {
  if (values.length === 0) {
    return undefined;
  }

  return new Date(Math.min(...values.map((value) => value.getTime())));
}

export function maxDate(values: readonly Date[]): Date | undefined {
  if (values.length === 0) {
    return undefined;
  }

  return new Date(Math.max(...values.map((value) => value.getTime())));
}

export function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function resourceIdentity(input: {
  readonly cloudResourceId?: string;
  readonly cloudConnectionId?: string;
  readonly externalResourceId: string;
}): string {
  return input.cloudResourceId
    ?? `${input.cloudConnectionId ?? 'unresolved'}\u0000${input.externalResourceId}`;
}

export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
