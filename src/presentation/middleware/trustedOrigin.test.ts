import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrustedOriginGuard } from './trustedOrigin.js';

describe('createTrustedOriginGuard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allows requests without an Origin header for non-browser clients', () => {
    vi.stubEnv('CORS_ORIGIN', 'https://finops.example.com');
    const next = vi.fn();
    const response = responseDouble();

    createTrustedOriginGuard()(requestDouble(undefined), response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
  });

  it('allows only explicitly configured browser origins', () => {
    vi.stubEnv('CORS_ORIGIN', 'https://finops.example.com,https://admin.example.com');
    const guard = createTrustedOriginGuard();
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
