import { describe, expect, test } from 'vitest';
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
});
