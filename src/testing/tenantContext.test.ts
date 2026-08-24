import { describe, expect, it } from 'vitest';
import { getDatabaseContext, runWithDatabaseContext } from '../infrastructure/database/tenantContext.js';

describe('runWithDatabaseContext', () => {
  it('preserves context while assimilating Prisma-style thenables', async () => {
    const prismaStyleThenable = {
      then: (resolve: (value: string | undefined) => void) => {
        void Promise.resolve().then(() => resolve(getDatabaseContext()?.workerId));
      },
    };

    const workerId = await runWithDatabaseContext(
      { role: 'MASTER_ADMIN', workerId: 'context-test-worker' },
      () => prismaStyleThenable,
    );

    expect(workerId).toBe('context-test-worker');
  });
});
