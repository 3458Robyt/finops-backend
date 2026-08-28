export interface IngestionRateLimit {
  readonly requestsPerSecond: number;
  readonly maxConcurrent: number;
}

interface BucketState {
  tokens: number;
  lastRefillAt: number;
  active: number;
  configuredRate: number;
  effectiveRate: number;
}

/**
 * Small in-process token bucket shared by all ingestion jobs in one backend
 * process. The key must include provider/account/region/API so independent
 * cloud accounts do not throttle each other while jobs for the same tenancy
 * respect the provider quota.
 */
export class IngestionRateCoordinator {
  private readonly buckets = new Map<string, BucketState>();

  public async run<T>(
    key: string,
    limit: IngestionRateLimit,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await this.acquire(key, limit, signal);
    try {
      const result = await operation();
      this.recordSuccess(key);
      return result;
    } catch (error) {
      if (isThrottleError(error)) this.recordThrottle(key);
      throw error;
    } finally {
      release();
    }
  }

  private async acquire(key: string, limit: IngestionRateLimit, signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    const requestsPerSecond = Math.max(0.1, limit.requestsPerSecond);
    const maxConcurrent = Math.max(1, Math.floor(limit.maxConcurrent));
    const capacity = Math.max(1, Math.ceil(requestsPerSecond));
    const state = this.buckets.get(key) ?? {
      tokens: capacity,
      lastRefillAt: Date.now(),
      active: 0,
      configuredRate: requestsPerSecond,
      effectiveRate: requestsPerSecond,
    } satisfies BucketState;
    this.buckets.set(key, state);
    state.configuredRate = requestsPerSecond;

    while (true) {
      const now = Date.now();
      const effectiveRefillPerMs = state.effectiveRate / 1_000;
      state.tokens = Math.min(capacity, state.tokens + (now - state.lastRefillAt) * effectiveRefillPerMs);
      state.lastRefillAt = now;
      if (state.active < maxConcurrent && state.tokens >= 1) {
        state.tokens -= 1;
        state.active += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          state.active = Math.max(0, state.active - 1);
        };
      }

      const tokenWaitMs = state.tokens < 1 ? Math.ceil((1 - state.tokens) / effectiveRefillPerMs) : 10;
      await delayWithAbort(Math.max(10, Math.min(1_000, tokenWaitMs)), signal);
    }
  }

  private recordThrottle(key: string): void {
    const state = this.buckets.get(key);
    if (state === undefined) return;
    state.effectiveRate = Math.max(0.5, state.effectiveRate * 0.5);
    state.tokens = 0;
    state.lastRefillAt = Date.now();
  }

  private recordSuccess(key: string): void {
    const state = this.buckets.get(key);
    if (state === undefined) return;
    state.effectiveRate = Math.min(state.configuredRate, state.effectiveRate + Math.max(0.1, state.configuredRate * 0.05));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await delay(ms);
    return;
  }

  if (signal.aborted) throw new Error('Ingestion operation cancelled');
  await Promise.race([
    delay(ms),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Ingestion operation cancelled')), { once: true });
    }),
  ]);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error('Ingestion operation cancelled');
}

function isThrottleError(error: unknown): boolean {
  if (error !== null && typeof error === 'object') {
    const status = (error as { status?: unknown; statusCode?: unknown }).statusCode
      ?? (error as { status?: unknown }).status;
    if (status === 429) return true;
  }
  return /rate exceeded|too many requests|throttl|429|server is busy|service unavailable|temporar/i.test(error instanceof Error ? error.message : String(error));
}
