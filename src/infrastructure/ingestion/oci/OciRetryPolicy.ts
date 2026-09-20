export async function withOciProviderRetry<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  delaysMs: readonly number[] = [1000, 2500, 5000],
  sleep: (delayMs: number) => Promise<void> = defaultSleep,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      throwIfAborted(signal);
      return await withTimeout(operation, timeoutMs, signal);
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === delaysMs.length) throw error;
      await sleepWithAbort(sleep, withJitter(delaysMs[attempt]!), signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('OCI operation failed after retries');
}

function withJitter(delayMs: number): number {
  // Full synchronization of retries is especially harmful when several jobs
  // share one OCI tenancy. Keep the configured backoff range but spread calls.
  return Math.max(1, Math.round(delayMs * (0.8 + Math.random() * 0.4)));
}

function isRetryableError(error: unknown): boolean {
  if (isStatus(error, 429) || isStatus(error, 500) || isStatus(error, 502) || isStatus(error, 503) || isStatus(error, 504)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /rate exceeded|too many requests|429|timeout|timed out|socket hang up|econnreset|temporar|server is busy|service unavailable|internal server error/i.test(message);
}

function isStatus(error: unknown, status: number): boolean {
  if (error === null || typeof error !== 'object') return false;
  const value = (error as { statusCode?: unknown; status?: unknown }).statusCode
    ?? (error as { status?: unknown }).status;
  return value === status;
}

async function withTimeout<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const attemptController = new AbortController();
  let timeoutTriggered = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortAttempt = (): void => attemptController.abort();
  signal?.addEventListener('abort', abortAttempt, { once: true });
  let cancellationListener: (() => void) | undefined;
  try {
    const operationPromise = operation(attemptController.signal);
    // The provider may ignore AbortSignal and reject after the timeout. Keep
    // that late rejection observed so a slow OCI call cannot become an
    // unhandled rejection while the retry loop has already moved on.
    void operationPromise.catch(() => undefined);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timeoutTriggered = true;
        attemptController.abort();
        reject(new Error(`OCI provider request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const cancellationPromise = signal === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
        cancellationListener = () => reject(new Error('OCI provider request cancelled'));
        if (signal.aborted) {
          cancellationListener();
          return;
        }
        signal.addEventListener('abort', cancellationListener, { once: true });
      });
    return await Promise.race([
      operationPromise,
      timeoutPromise,
      ...(cancellationPromise === undefined ? [] : [cancellationPromise]),
    ]);
  } catch (error) {
    if (timeoutTriggered) throw new Error(`OCI provider request timed out after ${timeoutMs}ms`);
    if (signal?.aborted === true) throw new Error('OCI provider request cancelled');
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', abortAttempt);
    if (signal !== undefined && cancellationListener !== undefined) {
      signal.removeEventListener('abort', cancellationListener);
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error('OCI provider request cancelled');
}

async function sleepWithAbort(
  sleep: (delayMs: number) => Promise<void>,
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (signal === undefined) {
    await sleep(delayMs);
    return;
  }
  let abortListener: (() => void) | undefined;
  try {
    await Promise.race([
      sleep(delayMs),
      new Promise<void>((_, reject) => {
        abortListener = () => reject(new Error('OCI provider request cancelled'));
        signal.addEventListener('abort', abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
