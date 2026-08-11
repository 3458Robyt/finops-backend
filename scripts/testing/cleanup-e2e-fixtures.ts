import {
  cleanupE2eFixtures,
  createTestingPrismaClient,
} from '../../src/testing/e2eFixtures.js';
import { Pool } from 'pg';

const prisma = createTestingPrismaClient();

try {
  const deletedTenants = await cleanupFixtureRows();
  console.log(JSON.stringify({
    success: true,
    deletedTenants,
    runId: process.env['E2E_RUN_ID'] ?? null,
  }, null, 2));
} finally {
  await prisma.$disconnect();
  await dropIsolatedSchema();
}

async function cleanupFixtureRows(): Promise<number> {
  try {
    return await cleanupE2eFixtures(prisma, process.env['E2E_RUN_ID']);
  } catch (error) {
    if (isMissingTableError(error)) return 0;
    throw error;
  }
}

function isMissingTableError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2021';
}

async function dropIsolatedSchema(): Promise<void> {
  const connectionString = process.env['TEST_DATABASE_URL'];
  if (connectionString === undefined) return;

  const url = new URL(connectionString);
  const schema = url.searchParams.get('schema');
  if (schema === null) return;
  if (!/^finops_e2e_[a-z0-9_]+$/.test(schema)) {
    throw new Error('Refusing to drop a schema outside the finops_e2e_* allowlist.');
  }

  url.searchParams.delete('schema');
  const pool = new Pool({ connectionString: url.toString() });
  try {
    await pool.query(`drop schema if exists "${schema}" cascade`);
    console.log(JSON.stringify({ success: true, droppedSchema: schema }, null, 2));
  } finally {
    await pool.end();
  }
}
