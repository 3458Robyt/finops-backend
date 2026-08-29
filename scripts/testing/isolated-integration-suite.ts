import 'dotenv/config';

import { resolve } from 'node:path';
import {
  assertIntegrationSchema,
  createIntegrationPool,
  runIntegrationCommand,
} from './integrationRuntime.js';

// The complete remote PostgreSQL suite includes fixture-heavy performance
// checks. Keep it bounded, but allow normal Supabase latency without forcing
// every developer to export a timeout manually. The runtime caps this at ten
// minutes and still validates any explicit override.
process.env['TEST_COMMAND_TIMEOUT_MS'] ??= '600000';

const sourceUrl = process.env['DATABASE_URL'];
if (sourceUrl === undefined || sourceUrl.trim() === '') {
  console.log(JSON.stringify({
    status: 'SKIPPED',
    reason: 'DATABASE_URL is required to create the isolated PostgreSQL integration schema.',
  }, null, 2));
  process.exit(0);
}

const schema = `finops_e2e_suite_${Date.now().toString(36)}`;
const isolatedUrl = withSchema(sourceUrl, schema);
const baseUrl = withoutSchema(sourceUrl);
const prismaCli = resolve('node_modules/prisma/build/index.js');
const vitestCli = resolve('node_modules/vitest/vitest.mjs');
const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
const integrationTests = [
  'src/testing/e2eFixtures.test.ts',
  'src/testing/technicalMetrics.integration.test.ts',
  'src/testing/recommendationAnalysis.integration.test.ts',
  'src/testing/verifiedSavingsMeasurement.integration.test.ts',
  'src/testing/valueRealization.integration.test.ts',
  'src/testing/tenantContext.integration.test.ts',
  'src/testing/agentQuality.integration.test.ts',
  'src/testing/agentLearningContext.integration.test.ts',
  'src/testing/resourceLinkage.integration.test.ts',
  'src/testing/costAllocation.integration.test.ts',
] as const;
const isolatedEnv = {
  DATABASE_URL: baseUrl,
  TEST_DATABASE_URL: isolatedUrl,
  ALLOW_DESTRUCTIVE_TEST_DATABASE: 'true',
  RUN_DB_INTEGRATION_TESTS: 'true',
  DB_RUNTIME_ENFORCE: 'true',
  DB_RUNTIME_ROLE: 'finops_runtime',
  DB_EXPECTED_MIGRATION: '202608290002_recommendation_candidate_audits',
};

let schemaCreated = false;
try {
  console.log(`[integration-suite] creating isolated schema ${schema}`);
  await createSchema(baseUrl, schema);
  schemaCreated = true;
  console.log('[integration-suite] deploying Prisma migrations');
  await runCommand(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    DATABASE_URL: isolatedUrl,
  });
  await verifyApiFunctionGrants(baseUrl, schema);

  console.log(`[integration-suite] running ${integrationTests.length} PostgreSQL integration files serially`);
  const vitestResult = await runCommand(
    process.execPath,
    [vitestCli, 'run', '--disableConsoleIntercept', '--no-file-parallelism', ...integrationTests],
    isolatedEnv,
  );
  process.stdout.write(vitestResult.stdout);
  process.stderr.write(vitestResult.stderr);

  const specializedScripts = [
    'scripts/testing/auth-lifecycle-cleanup-integration.ts',
    'scripts/testing/process-heartbeat-integration.ts',
  ] as const;
  for (const script of specializedScripts) {
    console.log(`[integration-suite] running ${script}`);
    const result = await runCommand(process.execPath, [tsxCli, script], {
      DATABASE_URL: baseUrl,
      TEST_DATABASE_URL: isolatedUrl,
      ALLOW_DESTRUCTIVE_TEST_DATABASE: 'true',
      RUN_DB_INTEGRATION_TESTS: 'true',
      DB_RUNTIME_ENFORCE: 'true',
      DB_RUNTIME_ROLE: 'finops_runtime',
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }

  console.log(JSON.stringify({
    status: 'PASSED',
    schema,
    tests: integrationTests,
    specialized: specializedScripts,
  }, null, 2));
} finally {
  if (schemaCreated) {
    await dropSchema(baseUrl, schema);
  }
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

async function verifyApiFunctionGrants(connectionString: string, schemaName: string): Promise<void> {
  const pool = createIntegrationPool(connectionString);
  try {
    const result = await pool.query<{ readonly routine_name: string; readonly grantee: string }>(`
      SELECT routine_name, grantee
      FROM information_schema.routine_privileges
      WHERE specific_schema = $1
        AND routine_name LIKE 'finops_%'
        AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
      ORDER BY routine_name, grantee
    `, [schemaName]);
    if (result.rows.length > 0) {
      throw new Error(`FinOps helper API grants detected in isolated schema: ${JSON.stringify(result.rows)}`);
    }
  } finally {
    await pool.end();
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  overrides: NodeJS.ProcessEnv,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return runIntegrationCommand(command, args, {
    ...isolatedEnv,
    ...overrides,
  });
}
