import 'dotenv/config';

import { resolve } from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { ProcessHeartbeatService } from '../../src/application/services/ProcessHeartbeatService.js';
import { OperationalReadinessService } from '../../src/application/services/OperationalReadinessService.js';
import { PrismaProcessHeartbeatRepository } from '../../src/infrastructure/repositories/PrismaProcessHeartbeatRepository.js';
import { PrismaOperationalReadinessRepository } from '../../src/infrastructure/repositories/PrismaOperationalReadinessRepository.js';
import { createTenantAwarePool, runWithDatabaseContext } from '../../src/infrastructure/database/tenantContext.js';
import type { RuntimeConfig } from '../../src/infrastructure/config/runtimeConfigTypes.js';
import { assertIntegrationSchema, createIntegrationPool, runIntegrationCommand } from './integrationRuntime.js';
const sourceUrl = process.env['DATABASE_URL'];
if (sourceUrl === undefined || sourceUrl.trim() === '') {
  throw new Error('DATABASE_URL is required for the isolated process heartbeat integration.');
}

const schema = `finops_e2e_process_heartbeat_${Date.now().toString(36)}`;
const isolatedUrl = withSchema(sourceUrl, schema);
const baseUrl = withoutSchema(sourceUrl);
const prismaCli = resolve('node_modules/prisma/build/index.js');
let admin: PrismaClient | undefined;
let runtime: PrismaClient | undefined;
let runtimePool: Pool | undefined;

try {
  await createSchema(baseUrl, schema);
  await runCommand(process.execPath, [prismaCli, 'migrate', 'deploy'], { DATABASE_URL: isolatedUrl });

  admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: isolatedUrl }, { schema }) });
  runtimePool = createTenantAwarePool(isolatedUrl, schema, {
    runtimeEnforce: true,
    runtimeRole: 'finops_runtime',
  });
  runtime = new PrismaClient({ adapter: new PrismaPg(runtimePool, { schema }) });

  const processId = 'process-heartbeat-integration';
  const startedAt = new Date();
  const service = new ProcessHeartbeatService(new PrismaProcessHeartbeatRepository(runtime), 30_000);
  await runWithDatabaseContext(
    { role: 'MASTER_ADMIN', workerId: processId },
    () => service.record({
      processId,
      processRole: 'worker',
      pid: 1234,
      startedAt,
      heartbeatAt: startedAt,
    }),
  );

  const visible = await runWithDatabaseContext(
    { role: 'MASTER_ADMIN', workerId: processId },
    () => runtime!.$transaction((transaction) => transaction.runtimeProcessHeartbeat.findUnique({ where: { processId } })),
  );
  assert(visible !== null && visible.status === 'RUNNING', 'The owner cannot read its heartbeat.');
  assert(await runWithDatabaseContext(
    { role: 'MASTER_ADMIN', workerId: processId },
    () => service.isFresh(processId, new Date(startedAt.getTime() + 29_999)),
  ), 'A recent heartbeat was classified as stale.');

  const readiness = new OperationalReadinessService(
    new PrismaOperationalReadinessRepository(runtime),
    service,
    {
      database: {
        runtimeEnforce: true,
        runtimeRole: 'finops_runtime',
        expectedMigration: '202608120005_runtime_process_heartbeats',
      },
      operations: { processHeartbeat: { enabled: true, intervalMs: 30_000, staleAfterMs: 30_000 } },
      ai: { apiKey: undefined },
    } as RuntimeConfig,
    processId,
  );
  const readinessReport = await runWithDatabaseContext(
    { role: 'MASTER_ADMIN', workerId: processId },
    () => readiness.check(),
  );
  assert(readinessReport.ready, `Operational readiness failed: ${JSON.stringify(readinessReport)}`);
  assert(readinessReport.checks.migrations === 'ok', 'Migration readiness was not verified.');
  assert(readinessReport.checks.lease === 'ok', 'Lease readiness was not verified.');

  const hiddenFromOtherProcess = await runWithDatabaseContext(
    { role: 'MASTER_ADMIN', workerId: 'another-process' },
    () => runtime!.$transaction((transaction) => transaction.runtimeProcessHeartbeat.findUnique({ where: { processId } })),
  );
  assert(hiddenFromOtherProcess === null, 'RLS exposed another process heartbeat.');

  await runWithDatabaseContext(
    { role: 'MASTER_ADMIN', workerId: processId },
    () => service.stop(processId, new Date(startedAt.getTime() + 1_000)),
  );
  assert(!await runWithDatabaseContext(
    { role: 'MASTER_ADMIN', workerId: processId },
    () => service.isFresh(processId, new Date(startedAt.getTime() + 2_000)),
  ), 'A stopped process was still classified as fresh.');

  const stopped = await admin.runtimeProcessHeartbeat.findUnique({ where: { processId } });
  assert(stopped?.status === 'STOPPED', 'The stopped state was not persisted.');
  console.log(JSON.stringify({ status: 'PASSED', processId, rlsIsolation: true, stopped: true }));
} finally {
  await runtime?.$disconnect();
  await admin?.$disconnect();
  await runtimePool?.end();
  await dropSchema(baseUrl, schema);
}

function withSchema(connectionString: string, schemaName: string): string {
  assertIntegrationSchema(schemaName);
  const url = new URL(connectionString);
  url.searchParams.set('schema', schemaName);
  return url.toString();
}

function withoutSchema(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.delete('schema');
  return url.toString();
}

async function createSchema(connectionString: string, schemaName: string): Promise<void> {
  assertIntegrationSchema(schemaName);
  const pool = createIntegrationPool(connectionString);
  try { await pool.query(`CREATE SCHEMA "${schemaName}"`); } finally { await pool.end(); }
}

async function dropSchema(connectionString: string, schemaName: string): Promise<void> {
  assertIntegrationSchema(schemaName);
  const pool = createIntegrationPool(connectionString);
  try { await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`); } finally { await pool.end(); }
}

async function runCommand(command: string, args: readonly string[], overrides: NodeJS.ProcessEnv): Promise<void> {
  await runIntegrationCommand(command, args, overrides);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
