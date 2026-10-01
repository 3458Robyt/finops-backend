import { describe, expect, test, vi } from 'vitest';
import { withPostgresDeadlockRetry } from './PrismaIngestionSamplePersistence.js';

describe('withPostgresDeadlockRetry', () => {
  test('retries a PostgreSQL deadlock and eventually succeeds', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('Raw query failed. Code: 40P01. Message: deadlock detected'))
      .mockResolvedValueOnce('ok');

    await expect(withPostgresDeadlockRetry(operation, async () => undefined)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  test('does not retry non-deadlock errors', async () => {
    const error = new Error('unique constraint violation');
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withPostgresDeadlockRetry(operation, async () => undefined)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
