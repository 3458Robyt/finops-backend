import type { CloudIngestionWorkerService } from './CloudIngestionWorkerService.js';

export interface CloudIngestionWorkerLoopHandle {
  stop(): void;
}

export interface CloudIngestionWorkerLoopOptions {
  readonly worker: Pick<CloudIngestionWorkerService, 'runOnce'>;
  readonly workerId: string;
  readonly intervalMs: number;
  readonly runImmediately?: boolean;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
  readonly onError?: (error: unknown) => void;
  readonly onSkip?: () => void;
}

export function startCloudIngestionWorkerLoop(options: CloudIngestionWorkerLoopOptions): CloudIngestionWorkerLoopHandle {
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : 30000;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  let running = false;

  const tick = (): void => {
    if (running) {
      options.onSkip?.();
      return;
    }

    running = true;
    options.worker.runOnce(options.workerId)
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
