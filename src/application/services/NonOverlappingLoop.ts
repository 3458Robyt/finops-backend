export interface NonOverlappingLoopHandle {
  stop(): void;
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
}

export function startNonOverlappingLoop(options: NonOverlappingLoopOptions): NonOverlappingLoopHandle {
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0
    ? options.intervalMs
    : options.fallbackIntervalMs;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  let running = false;

  const tick = (): void => {
    if (running) {
      options.onSkip?.();
      return;
    }

    running = true;
    options.run()
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => { running = false; });
  };

  if (options.runImmediately !== false) tick();

  const timer = setIntervalFn(tick, intervalMs);
  if (options.unref === true && typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref();
  }

  return { stop: () => clearIntervalFn(timer) };
}
