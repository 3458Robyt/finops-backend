import type { RequestHandler } from 'express';

export interface RateLimitOptions {
  readonly windowMs: number;
  readonly limit: number;
  readonly message?: unknown;
  readonly standardHeaders?: boolean;
  readonly legacyHeaders?: boolean;
  readonly maxBuckets?: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

/** Limitador local y acotado para desarrollo o una instancia única. */
export function createRateLimit(options: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, RateLimitBucket>();
  const maxBuckets = options.maxBuckets ?? 10_000;

  return (req, res, next): void => {
    const now = Date.now();
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    pruneExpiredBuckets(buckets, now, maxBuckets);
    const current = buckets.get(key);
    const bucket = current === undefined || current.resetAt <= now
      ? { count: 0, resetAt: now + options.windowMs }
      : current;
    bucket.count += 1;
    buckets.set(key, bucket);

    res.setHeader('RateLimit-Limit', options.limit);
    res.setHeader('RateLimit-Remaining', Math.max(0, options.limit - bucket.count));
    res.setHeader('RateLimit-Reset', Math.ceil((bucket.resetAt - now) / 1000));
    if (bucket.count > options.limit) {
      res.status(429).json(options.message ?? { success: false, code: 'RATE_LIMITED' });
      return;
    }
    next();
  };
}

function pruneExpiredBuckets(
  buckets: Map<string, RateLimitBucket>,
  now: number,
  maxBuckets: number,
): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }

  // Mantener el mapa acotado incluso si un atacante rota muchas IPs.
  while (buckets.size >= maxBuckets) {
    const oldest = buckets.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    buckets.delete(oldest);
  }
}
