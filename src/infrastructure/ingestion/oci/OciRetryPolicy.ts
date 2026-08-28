export async function withOciProviderRetry<T>(
  operation: () => Promise<T>,
  delaysMs: readonly number[] = [1000, 2500, 5000],
  sleep: (delayMs: number) => Promise<void> = defaultSleep,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      throwIfAborted(signal);
      return await withTimeout(operation(), timeoutMs, signal);
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`OCI provider request timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
      ...(signal === undefined ? [] : [new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new Error('OCI provider request cancelled'));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('OCI provider request cancelled')), { once: true });
      })]),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
  await Promise.race([
    sleep(delayMs),
    new Promise<void>((_, reject) => {
      if (signal.aborted) {
        reject(new Error('OCI provider request cancelled'));
        return;
      }
      signal.addEventListener('abort', () => reject(new Error('OCI provider request cancelled')), { once: true });
    }),
  ]);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
