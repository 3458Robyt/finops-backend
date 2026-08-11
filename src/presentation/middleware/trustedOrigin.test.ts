import { describe, expect, it, vi } from 'vitest';
import { createTrustedOriginGuard } from './trustedOrigin.js';

describe('createTrustedOriginGuard', () => {
  it('allows requests without an Origin header for non-browser clients', () => {
    const next = vi.fn();
    const response = responseDouble();

    createTrustedOriginGuard(['https://finops.example.com'])(requestDouble(undefined), response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
  });

  it('allows only explicitly configured browser origins', () => {
    const guard = createTrustedOriginGuard(['https://finops.example.com', 'https://admin.example.com']);
    const next = vi.fn();
    const response = responseDouble();

    guard(requestDouble('https://admin.example.com'), response, next);
    guard(requestDouble('https://evil.example'), response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CSRF_ORIGIN_REJECTED' }));
  });
});

function requestDouble(origin: string | undefined) {
  return {
    header: (name: string) => name === 'origin' ? origin : undefined,
  } as never;
}

function responseDouble() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as never;
}
