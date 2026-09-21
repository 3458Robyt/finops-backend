import { describe, expect, test, vi } from 'vitest';
import { IngestionRateCoordinator } from './IngestionRateCoordinator.js';

describe('IngestionRateCoordinator', () => {
  test('limits concurrent provider calls per account/API key', async () => {
    const coordinator = new IngestionRateCoordinator();
    let active = 0;
    let peak = 0;
    const operation = async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
    };

    await Promise.all(Array.from({ length: 8 }, () => coordinator.run(
      'oci:tenancy:region:monitoring',
      { requestsPerSecond: 100, maxConcurrent: 2 },
      operation,
    )));

    expect(peak).toBeLessThanOrEqual(2);
  });

  test('does not throttle independent account/API keys together', async () => {
    const coordinator = new IngestionRateCoordinator();
    const started: string[] = [];
    await Promise.all([
      coordinator.run('oci:a:region:monitoring', { requestsPerSecond: 100, maxConcurrent: 1 }, async () => { started.push('a'); }),
      coordinator.run('oci:b:region:monitoring', { requestsPerSecond: 100, maxConcurrent: 1 }, async () => { started.push('b'); }),
    ]);
    expect(started.sort()).toEqual(['a', 'b']);
  });

  test('cleans abort listeners after a queued call is released', async () => {
    const coordinator = new IngestionRateCoordinator();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });

    const first = coordinator.run(
      'oci:tenancy:monitoring',
      { requestsPerSecond: 100, maxConcurrent: 1 },
      async () => {
        firstStarted();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      },
      controller.signal,
    );
    await started;
    const second = coordinator.run(
      'oci:tenancy:monitoring',
      { requestsPerSecond: 100, maxConcurrent: 1 },
      async () => undefined,
      controller.signal,
    );

    releaseFirst();
    await Promise.all([first, second]);

    expect(addListener).toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
