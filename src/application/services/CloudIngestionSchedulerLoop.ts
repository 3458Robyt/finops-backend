export interface CloudIngestionSchedulerLoopHandle {
  stop(): void;
}

export interface CloudIngestionSchedulerLoopOptions {
  readonly scheduler: {
    runOnce(): Promise<unknown>;
  };
  readonly intervalMs: number;
  readonly runImmediately?: boolean;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
  readonly onError?: (error: unknown) => void;
  readonly onSkip?: () => void;
}

export function startCloudIngestionSchedulerLoop(
  options: CloudIngestionSchedulerLoopOptions,
): CloudIngestionSchedulerLoopHandle {
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : 300000;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  let running = false;

  const tick = (): void => {
    if (running) {
      options.onSkip?.();
      return;
    }

    running = true;
    options.scheduler.runOnce()
      .catch((error: unknown) => {
        options.onError?.(error);
      })
      .finally(() => {
        running = false;
      });
  };

  if (options.runImmediately !== false) {
    tick();
  }

  const timer = setIntervalFn(tick, intervalMs);

  return {
    stop: () => {
      clearIntervalFn(timer);
    },
  };
}
