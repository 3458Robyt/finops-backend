import { describe, expect, test, vi } from 'vitest';
import { withOciProviderRetry } from './OciRetryPolicy.js';

describe('OCI retry policy', () => {
  test('retries rate limits using the configured delays', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockResolvedValue('ok');
    const sleep = vi.fn(async () => undefined);

    await expect(withOciProviderRetry(operation, [25], sleep)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(20);
    expect(sleep.mock.calls[0]?.[0]).toBeLessThanOrEqual(30);
  });

  test('does not retry non-rate-limit failures', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('Bad request'));
    const sleep = vi.fn(async () => undefined);
    await expect(withOciProviderRetry(operation, [25], sleep)).rejects.toThrow('Bad request');
    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});
