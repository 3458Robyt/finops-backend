import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTenantAwarePool, runWithDatabaseContext } from '../infrastructure/database/tenantContext.js';

const integrationEnabled = process.env['RUN_DB_INTEGRATION_TESTS'] === 'true';

describe.skipIf(!integrationEnabled)('runtime tenant context', () => {
  let pool: Pool;

  beforeAll(() => {
    const connectionString = process.env['TEST_DATABASE_URL'];
    if (connectionString === undefined || connectionString.trim() === '') {
      throw new Error('TEST_DATABASE_URL is required for runtime tenant context integration tests.');
    }

    const schema = new URL(connectionString).searchParams.get('schema') ?? undefined;
    process.env['DB_RUNTIME_ENFORCE'] = 'true';
    process.env['DB_RUNTIME_ROLE'] = 'finops_runtime';
    pool = createTenantAwarePool(connectionString, schema ?? undefined);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('keeps tenant-owned rows isolated across context switches', async () => {
    const tenants = await runWithDatabaseContext(
      { userId: 'runtime-context-test', role: 'MASTER_ADMIN' },
      () => pool.query('select id from tenants order by id limit 2'),
    );
    expect(tenants.rows.length).toBeGreaterThanOrEqual(2);

    const [tenantA, tenantB] = tenants.rows as [{ id: string }, { id: string }];
    const tenantAResult = await runWithDatabaseContext(
      { tenantId: tenantA.id, userId: 'runtime-context-test', role: 'ADMIN' },
      () => pool.query("select current_user as db_user, current_setting('app.tenant_id', true) as tenant_id, count(*)::int as visible_rows from recommendations"),
    );
    expect(tenantAResult.rows[0]).toMatchObject({
      db_user: 'finops_runtime',
      tenant_id: tenantA.id,
    });

    const crossTenantRows = await runWithDatabaseContext(
      { tenantId: tenantA.id, userId: 'runtime-context-test', role: 'ADMIN' },
      () => pool.query('select count(*)::int as visible_rows from recommendations where tenant_id = $1', [tenantB.id]),
    );
    expect(crossTenantRows.rows[0]?.visible_rows).toBe(0);

    const tenantBResult = await runWithDatabaseContext(
      { tenantId: tenantB.id, userId: 'runtime-context-test', role: 'ADMIN' },
      () => pool.query('select count(*)::int as visible_rows from recommendations'),
    );
    expect(tenantBResult.rows[0]?.visible_rows).toBeGreaterThanOrEqual(0);

    const unscopedRows = await runWithDatabaseContext({}, () => pool.query('select count(*)::int as visible_rows from recommendations'));
    expect(unscopedRows.rows[0]?.visible_rows).toBe(0);
  });
});
