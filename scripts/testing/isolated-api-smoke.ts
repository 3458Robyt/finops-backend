import 'dotenv/config';

import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import {
  assertIntegrationSchema,
  runIntegrationCommand,
} from './integrationRuntime.js';

// Supabase API smoke includes two authenticated suites and can take several
// minutes over a remote PostgreSQL connection. Keep it bounded without
// requiring every developer to set a timeout manually.
process.env['TEST_COMMAND_TIMEOUT_MS'] ??= '600000';

const execFileAsync = promisify(execFile);
const sourceUrl = process.env['DATABASE_URL'];

if (sourceUrl === undefined || sourceUrl.trim() === '') {
  console.log(JSON.stringify({
    status: 'SKIPPED',
    reason: 'DATABASE_URL is required to create the isolated API smoke schema.',
  }, null, 2));
  process.exit(0);
}

const schema = `finops_e2e_api_${Date.now().toString(36)}`;
const isolatedUrl = withSchema(sourceUrl, schema);
const baseUrl = withoutSchema(sourceUrl);
const fixtureFile = resolve(process.env['E2E_FIXTURE_FILE'] ?? `.test-artifacts/${schema}.json`);
const port = Number.parseInt(process.env['API_SMOKE_PORT'] ?? '3021', 10);
const apiBaseUrl = `http://127.0.0.1:${port}/api/v1`;
const prismaCli = resolve('node_modules/prisma/build/index.js');
const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
const runId = process.env['E2E_RUN_ID'] ?? `api-smoke-${Date.now()}`;
const serverOutput: string[] = [];
let server: ChildProcess | undefined;
let schemaCreated = false;

await mkdir(resolve('.test-artifacts'), { recursive: true });

try {
  assertPort(port);
  assertIntegrationSchema(schema);
  await createSchema(baseUrl, schema);
  schemaCreated = true;

  await runIntegrationCommand(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    DATABASE_URL: isolatedUrl,
  });
  await runIntegrationCommand(process.execPath, [tsxCli, 'scripts/testing/create-e2e-fixtures.ts'], {
    DATABASE_URL: baseUrl,
    TEST_DATABASE_URL: isolatedUrl,
    ALLOW_DESTRUCTIVE_TEST_DATABASE: 'true',
    E2E_RUN_ID: runId,
    E2E_FIXTURE_FILE: fixtureFile,
  });

  server = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: isolatedUrl,
      PORT: String(port),
      APP_PROCESS_ROLE: 'api',
      DB_RUNTIME_ENFORCE: 'true',
      DB_RUNTIME_ROLE: 'finops_runtime',
      DB_EXPECTED_MIGRATION: '202608120008_revoke_login_tenant_api_grants',
      PROCESS_HEARTBEAT_ENABLED: 'false',
      INGESTION_WORKER_ENABLED: 'false',
      INGESTION_SCHEDULER_ENABLED: 'false',
      RECOMMENDATION_ANALYSIS_WORKER_ENABLED: 'false',
      RECOMMENDATION_ANALYSIS_SCHEDULER_ENABLED: 'false',
      AGENT_LEARNING_WORKER_ENABLED: 'false',
      MESSAGE_SCHEDULER_ENABLED: 'false',
      AUTH_CLEANUP_SCHEDULER_ENABLED: 'false',
      BUDGET_SCHEDULER_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  server.stdout?.on('data', (chunk: Buffer) => appendOutput(serverOutput, chunk));
  server.stderr?.on('data', (chunk: Buffer) => appendOutput(serverOutput, chunk));
  await waitForHealth(`http://127.0.0.1:${port}/health`, serverOutput);

  const result = await runIntegrationCommand(process.execPath, [tsxCli, 'scripts/testing/api-smoke.ts'], {
    E2E_API_BASE_URL: apiBaseUrl,
    E2E_FIXTURE_FILE: fixtureFile,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const onboardingResult = await runIntegrationCommand(process.execPath, [tsxCli, 'scripts/testing/cloud-onboarding-api-smoke.ts'], {
    API_BASE_URL: apiBaseUrl,
    E2E_FIXTURE_FILE: fixtureFile,
  });
  process.stdout.write(onboardingResult.stdout);
  process.stderr.write(onboardingResult.stderr);
  console.log(JSON.stringify({ status: 'PASSED', schema, apiBaseUrl, suites: ['api-smoke', 'cloud-onboarding-api-smoke'] }, null, 2));
} finally {
  await stopProcess(server);
  await rm(fixtureFile, { force: true }).catch(() => undefined);
  if (schemaCreated) await dropSchema(baseUrl, schema);
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
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
  try {
    await pool.query(`CREATE SCHEMA "${schemaName}"`);
  } finally {
    await pool.end();
  }
}

async function dropSchema(connectionString: string, schemaName: string): Promise<void> {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  } finally {
    await pool.end();
  }
}

async function waitForHealth(url: string, output: readonly string[]): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The API is still starting or the port is not open yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Backend did not become healthy. Output:\n${output.join('')}`);
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => undefined);
    return;
  }
  child.kill('SIGTERM');
}

function appendOutput(buffer: string[], chunk: Buffer): void {
  buffer.push(chunk.toString());
  if (buffer.length > 20) buffer.shift();
}

function assertPort(value: number): void {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error('API_SMOKE_PORT must be an integer between 1024 and 65535.');
  }
}
