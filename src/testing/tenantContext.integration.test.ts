import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTenantAwarePool, runWithDatabaseContext } from '../infrastructure/database/tenantContext.js';
import {
  cleanupE2eFixtures,
  createE2eFixtures,
  createTestingPrismaClient,
  type E2eFixtureManifest,
} from './e2eFixtures.js';

const integrationEnabled = process.env['RUN_DB_INTEGRATION_TESTS'] === 'true';

describe.skipIf(!integrationEnabled)('runtime tenant context', () => {
  let pool: Pool;
  let fixturePrisma: ReturnType<typeof createTestingPrismaClient>;
  let fixtures: E2eFixtureManifest;

  beforeAll(() => {
    const connectionString = process.env['TEST_DATABASE_URL'];
    if (connectionString === undefined || connectionString.trim() === '') {
      throw new Error('TEST_DATABASE_URL is required for runtime tenant context integration tests.');
    }

    const schema = new URL(connectionString).searchParams.get('schema') ?? undefined;
    process.env['DB_RUNTIME_ENFORCE'] = 'true';
    process.env['DB_RUNTIME_ROLE'] = 'finops_runtime';
    pool = createTenantAwarePool(connectionString, schema ?? undefined);
    fixturePrisma = createTestingPrismaClient();
    return createE2eFixtures(fixturePrisma, `tenant-context-${Date.now()}`).then((created) => { fixtures = created; });
  }, 120_000);

  afterAll(async () => {
    if (fixturePrisma !== undefined && fixtures !== undefined) {
      await cleanupE2eFixtures(fixturePrisma, fixtures.runId);
      await fixturePrisma.$disconnect();
    }
    await pool?.end();
  }, 120_000);

  it('keeps tenant-owned rows isolated across context switches', async () => {
    const tenants = await runWithDatabaseContext(
      { userId: 'runtime-context-test', role: 'MASTER_ADMIN' },
      () => pool.query('select id from tenants order by id limit 2'),
    );
    expect(tenants.rows.length).toBeGreaterThanOrEqual(2);

    const [tenantA, tenantB] = fixtures.tenants as [{ id: string }, { id: string }];
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

  it('lets master admins inspect jobs and their connections across tenants', async () => {
    const [tenantA, tenantB] = fixtures.tenants as [{ id: string }, { id: string }];
    const connections = await fixturePrisma.cloudConnection.findMany({
      where: { tenantId: { in: [tenantA.id, tenantB.id] } },
      select: { id: true, tenantId: true },
    });
    expect(connections).toHaveLength(2);

    const now = new Date();
    await fixturePrisma.ingestionJob.createMany({
      data: connections.map((connection) => ({
        tenantId: connection.tenantId,
        cloudConnectionId: connection.id,
        sourceType: 'INVENTORY' as const,
        status: 'PENDING' as const,
        targetStart: now,
        targetEnd: now,
      })),
    });

    const masterRows = await runWithDatabaseContext(
      { tenantId: tenantA.id, userId: 'runtime-master-admin', role: 'MASTER_ADMIN' },
      () => pool.query(
        `select j.tenant_id, c.tenant_id as connection_tenant_id
         from ingestion_jobs j
         join cloud_connections c on c.id = j.cloud_connection_id
         where j.tenant_id = any($1::text[])
         order by j.tenant_id`,
        [[tenantA.id, tenantB.id]],
      ),
    );
    expect(masterRows.rows).toHaveLength(2);
    expect(masterRows.rows.map((row) => row.tenant_id)).toEqual([tenantA.id, tenantB.id].sort());
    expect(masterRows.rows.every((row) => row.tenant_id === row.connection_tenant_id)).toBe(true);

    const regularRows = await runWithDatabaseContext(
      { tenantId: tenantA.id, userId: 'runtime-tenant-admin', role: 'ADMIN' },
      () => pool.query('select count(*)::int as visible_rows from ingestion_jobs where tenant_id = $1', [tenantB.id]),
    );
    expect(regularRows.rows[0]?.visible_rows).toBe(0);
  });

  it('allows runtime transactions to write on read-only-by-default pooler sessions', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('create temporary table runtime_write_probe(value integer)');
      await client.query('insert into runtime_write_probe(value) values (1)');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('allows implicit Prisma-style statements to write on pooler sessions', async () => {
    const client = await pool.connect();
    try {
      await client.query('create temporary table runtime_implicit_write_probe(value integer)');
      await client.query('insert into runtime_implicit_write_probe(value) values (1)');
      const result = await client.query('select count(*)::int as rows from runtime_implicit_write_probe');
      expect(result.rows[0]?.rows).toBe(1);
    } finally {
      client.release();
    }
  });
});
