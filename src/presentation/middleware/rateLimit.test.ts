import { describe, expect, it, vi } from 'vitest';
import { createRateLimit } from './rateLimit.js';

describe('createRateLimit', () => {
  it('limits each client and exposes standard headers', () => {
    const middleware = createRateLimit({ windowMs: 60_000, limit: 1 });
    const next = vi.fn();
    const response = responseDouble();
    const request = requestDouble('client-a');

    middleware(request, response, next);
    middleware(request, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).toHaveBeenCalledWith(429);
    expect(response.json).toHaveBeenCalledWith({ success: false, code: 'RATE_LIMITED' });
    expect(response.setHeader).toHaveBeenCalledWith('RateLimit-Limit', 1);
  });

  it('keeps client buckets bounded when IPs rotate', () => {
    const middleware = createRateLimit({ windowMs: 60_000, limit: 10, maxBuckets: 2 });
    const next = vi.fn();
    const response = responseDouble();

    middleware(requestDouble('client-a'), response, next);
    middleware(requestDouble('client-b'), response, next);
    middleware(requestDouble('client-c'), response, next);

    expect(next).toHaveBeenCalledTimes(3);
  });
});

function requestDouble(ip: string) {
  return { ip, socket: { remoteAddress: ip } } as never;
}

function responseDouble() {
  return {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as never;
}
