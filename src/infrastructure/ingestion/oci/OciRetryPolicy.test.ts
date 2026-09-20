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

  test('retries OCI transient server-busy responses', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('Server is busy at this moment.'))
      .mockResolvedValue('ok');
    const sleep = vi.fn(async () => undefined);

    await expect(withOciProviderRetry(operation, [25], sleep)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  test('does not retry non-rate-limit failures', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('Bad request'));
    const sleep = vi.fn(async () => undefined);
    await expect(withOciProviderRetry(operation, [25], sleep)).rejects.toThrow('Bad request');
    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  test('aborts the provider attempt when its timeout expires', async () => {
    let aborted = false;
    const operation = (signal?: AbortSignal) => new Promise<string>((_, reject) => {
      signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      }, { once: true });
    });

    await expect(withOciProviderRetry(operation, [], undefined, 5)).rejects.toThrow('timed out');
    expect(aborted).toBe(true);
  });

  test('removes the backoff abort listener after the delay completes', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('429 Too Many Requests'));
    const sleep = vi.fn(async () => undefined);
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');

    await expect(withOciProviderRetry(operation, [25], sleep, 1000, controller.signal))
      .rejects.toThrow('429 Too Many Requests');

    expect(addListener).toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalled();
  });
});
