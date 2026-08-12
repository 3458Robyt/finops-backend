import 'dotenv/config';

import { resolve } from 'node:path';
import { assertIntegrationSchema, createIntegrationPool, runIntegrationCommand } from './integrationRuntime.js';
const sourceUrl = process.env['DATABASE_URL'];
if (sourceUrl === undefined || sourceUrl.trim() === '') {
  throw new Error('DATABASE_URL is required to run the isolated resource-lineage integration suite.');
}

const schema = `finops_e2e_resource_lineage_${Date.now().toString(36)}`;
const isolatedUrl = withSchema(sourceUrl, schema);
const baseUrl = withoutSchema(sourceUrl);
const prismaCli = resolve('node_modules/prisma/build/index.js');
const vitestCli = resolve('node_modules/vitest/vitest.mjs');

try {
  await createSchema(baseUrl, schema);
  await runCommand(process.execPath, [prismaCli, 'migrate', 'deploy'], { DATABASE_URL: isolatedUrl });
  const result = await runCommand(process.execPath, [vitestCli, 'run', '--disableConsoleIntercept', 'src/testing/resourceLinkage.integration.test.ts'], {
    DATABASE_URL: baseUrl,
    TEST_DATABASE_URL: isolatedUrl,
    ALLOW_DESTRUCTIVE_TEST_DATABASE: 'true',
    RUN_DB_INTEGRATION_TESTS: 'true',
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} finally {
  await dropSchema(baseUrl, schema);
}

function withSchema(connectionString: string, schemaName: string): string {
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
  try {
    await pool.query(`CREATE SCHEMA "${schemaName}"`);
  } finally {
    await pool.end();
  }
}

async function dropSchema(connectionString: string, schemaName: string): Promise<void> {
  assertIntegrationSchema(schemaName);
  const pool = createIntegrationPool(connectionString);
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  } finally {
    await pool.end();
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  overrides: NodeJS.ProcessEnv,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return runIntegrationCommand(command, args, overrides);
}
