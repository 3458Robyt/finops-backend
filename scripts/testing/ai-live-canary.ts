import 'dotenv/config';

import { execFile, spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const execFileAsync = promisify(execFile);
const sourceUrl = process.env['DATABASE_URL'];
if (sourceUrl === undefined || sourceUrl.trim() === '') {
  throw new Error('DATABASE_URL is required for the isolated AI canary.');
}

const schema = `finops_e2e_ai_${Date.now().toString(36)}`;
const runId = process.env['E2E_RUN_ID'] ?? `ai-canary-${Date.now()}`;
const fixtureFile = resolve(process.env['E2E_FIXTURE_FILE'] ?? `.test-artifacts/${schema}.json`);
const port = Number(process.env['AI_CANARY_PORT'] ?? 3014);
const apiBaseUrl = `http://127.0.0.1:${port}/api/v1`;
const isolatedUrl = withSchema(sourceUrl, schema);
const baseUrl = withoutSchema(sourceUrl);
const nodeCommand = process.execPath;
const prismaCli = resolve('node_modules/prisma/build/index.js');
const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
let server: ReturnType<typeof spawn> | undefined;
const serverOutput: string[] = [];

await mkdir(resolve('.test-artifacts'), { recursive: true });

try {
  await createSchema(baseUrl, schema);
  await runCommand(nodeCommand, [prismaCli, 'migrate', 'deploy'], {
    DATABASE_URL: isolatedUrl,
  });
  await runCommand(nodeCommand, [tsxCli, 'scripts/testing/create-e2e-fixtures.ts'], {
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
      DB_RUNTIME_ENFORCE: 'true',
      DB_RUNTIME_ROLE: 'finops_runtime',
      INGESTION_WORKER_ENABLED: 'false',
      INGESTION_SCHEDULER_ENABLED: 'false',
      RECOMMENDATION_ANALYSIS_WORKER_ENABLED: 'false',
      RECOMMENDATION_ANALYSIS_SCHEDULER_ENABLED: 'false',
      AGENT_LEARNING_WORKER_ENABLED: 'false',
      MESSAGE_SCHEDULER_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  server.stdout?.on('data', (chunk: Buffer) => appendOutput(serverOutput, chunk));
  server.stderr?.on('data', (chunk: Buffer) => appendOutput(serverOutput, chunk));
  await waitForHealth(`http://127.0.0.1:${port}/health`, serverOutput);

  const audit = await runCommand(nodeCommand, [tsxCli, 'scripts/testing/ai-live-audit.ts'], {
    AI_LIVE_TESTS: 'true',
    E2E_API_BASE_URL: apiBaseUrl,
    E2E_FIXTURE_FILE: fixtureFile,
  });
  console.log(audit.stdout.trim());
  if (audit.stderr.trim() !== '') {
    console.error(audit.stderr.trim());
  }
} catch (error: unknown) {
  console.error(`AI live canary backend output:\n${serverOutput.join('')}`);
  throw error;
} finally {
  await stopProcess(server);
  await dropSchema(baseUrl, schema);
  await rm(fixtureFile, { force: true }).catch(() => undefined);
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
  const pool = new Pool({ connectionString });
  try {
    await pool.query(`create schema "${schemaName}"`);
  } finally {
    await pool.end();
  }
}

async function dropSchema(connectionString: string, schemaName: string): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    await pool.query(`drop schema if exists "${schemaName}" cascade`);
  } finally {
    await pool.end();
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  overrides: NodeJS.ProcessEnv,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await execFileAsync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...overrides },
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function waitForHealth(url: string, output: readonly string[]): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Backend did not become healthy. Output:\n${output.join('')}`);
}

async function stopProcess(child: ReturnType<typeof spawn> | undefined): Promise<void> {
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
