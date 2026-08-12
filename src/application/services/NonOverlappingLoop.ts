import type { MetricsRegistry } from '../observability/MetricsRegistry.js';

export interface NonOverlappingLoopHandle {
  stop(): void;
  waitForIdle(): Promise<void>;
}

export interface NonOverlappingLoopOptions {
  readonly run: () => Promise<unknown>;
  readonly intervalMs: number;
  readonly fallbackIntervalMs: number;
  readonly runImmediately?: boolean;
  readonly unref?: boolean;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
  readonly onError?: (error: unknown) => void;
  readonly onSkip?: () => void;
  readonly metrics?: MetricsRegistry;
  readonly metricName?: string;
  readonly metricLabels?: Readonly<Record<string, string>>;
}

export function startNonOverlappingLoop(options: NonOverlappingLoopOptions): NonOverlappingLoopHandle {
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0
    ? options.intervalMs
    : options.fallbackIntervalMs;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const record = (suffix: string): void => {
    if (options.metrics === undefined || options.metricName === undefined) return;
    options.metrics.increment(`${options.metricName}_${suffix}`, options.metricLabels);
  };
  const recordDuration = (startedAt: number, outcome: 'success' | 'error'): void => {
    if (options.metrics === undefined || options.metricName === undefined) return;
    options.metrics.observe(
      `${options.metricName}_duration_ms`,
      Date.now() - startedAt,
      { ...options.metricLabels, outcome },
    );
  };
  let running = false;
  let activeRun: Promise<void> | undefined;

  const tick = (): void => {
    if (running) {
      options.onSkip?.();
      record('skipped_total');
      return;
    }

    running = true;
    const startedAt = Date.now();
    record('started_total');
    let result: Promise<unknown>;
    try {
      result = options.run();
    } catch (error: unknown) {
      running = false;
      record('failed_total');
      recordDuration(startedAt, 'error');
      options.onError?.(error);
      return;
    }

    let execution: Promise<void>;
    execution = Promise.resolve(result)
      .then(
        () => {
          record('completed_total');
          recordDuration(startedAt, 'success');
        },
        (error: unknown) => {
          record('failed_total');
          recordDuration(startedAt, 'error');
          options.onError?.(error);
        },
      )
      .finally(() => {
        running = false;
        if (activeRun === execution) activeRun = undefined;
      });
    activeRun = execution;
    void execution;
  };

  if (options.runImmediately !== false) tick();

  const timer = setIntervalFn(tick, intervalMs);
  if (options.unref === true && typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref();
  }

  return {
    stop: () => clearIntervalFn(timer),
    waitForIdle: async () => {
      const pending = activeRun;
      if (pending !== undefined) await pending;
    },
  };
}
