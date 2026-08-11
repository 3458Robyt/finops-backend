export async function withOciProviderRetry<T>(
  operation: () => Promise<T>,
  delaysMs: readonly number[] = [1000, 2500, 5000],
  sleep: (delayMs: number) => Promise<void> = defaultSleep,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempt === delaysMs.length) throw error;
      await sleep(delaysMs[attempt]!);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('OCI operation failed after retries');
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /rate exceeded|too many requests|429/i.test(message);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
