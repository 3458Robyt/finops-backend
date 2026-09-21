import type { OciRetryEvent } from './OciRetryPolicy.js';

export type OciMonitoringWithRetry = <T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  onRetry?: (event: OciRetryEvent) => void,
) => Promise<T>;

export interface OciMonitoringRetryTelemetry {
  readonly withRetry: OciMonitoringWithRetry;
  readonly initialCoverage: Readonly<Record<string, number>>;
  track<T>(batches: AsyncIterable<readonly T[]>, coverage: Record<string, unknown>): AsyncIterable<readonly T[]>;
}

export function createOciMonitoringRetryTelemetry(
  withRetry: OciMonitoringWithRetry,
): OciMonitoringRetryTelemetry {
  const stats = { retries: 0, rateLimitRetries: 0, timeoutRetries: 0, transientRetries: 0 };
  const observedWithRetry: OciMonitoringWithRetry = (operation, signal, onRetry) => withRetry(
    operation,
    signal,
    (event) => {
      stats.retries += 1;
      if (event.reason === 'RATE_LIMIT') stats.rateLimitRetries += 1;
      if (event.reason === 'TIMEOUT') stats.timeoutRetries += 1;
      if (event.reason === 'TRANSIENT') stats.transientRetries += 1;
      onRetry?.(event);
    },
  );
  return {
    withRetry: observedWithRetry,
    initialCoverage: {
      providerRetries: 0,
      providerRateLimitRetries: 0,
      providerTimeoutRetries: 0,
      providerTransientRetries: 0,
    },
    track: <T>(batches: AsyncIterable<readonly T[]>, coverage: Record<string, unknown>) => (async function* (): AsyncGenerator<readonly T[]> {
      try {
        for await (const batch of batches) yield batch;
      } finally {
        coverage.providerRetries = stats.retries;
        coverage.providerRateLimitRetries = stats.rateLimitRetries;
        coverage.providerTimeoutRetries = stats.timeoutRetries;
        coverage.providerTransientRetries = stats.transientRetries;
      }
    }()),
  };
}
