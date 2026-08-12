import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 180_000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

export interface IntegrationCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export function createIntegrationPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    connectionTimeoutMillis: 10_000,
    statement_timeout: integrationTimeoutMs(),
  });
}

export async function runIntegrationCommand(
  command: string,
  args: readonly string[],
  overrides: NodeJS.ProcessEnv,
): Promise<IntegrationCommandResult> {
  return execFileAsync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...overrides },
    maxBuffer: 20 * 1024 * 1024,
    timeout: integrationTimeoutMs(),
    killSignal: 'SIGTERM',
    windowsHide: true,
  });
}

export function assertIntegrationSchema(schemaName: string): void {
  if (!/^finops_e2e_[a-z0-9_]+$/.test(schemaName)) {
    throw new Error('Refusing to operate outside the finops_e2e_* schema allowlist.');
  }
}

function integrationTimeoutMs(): number {
  const raw = process.env['TEST_COMMAND_TIMEOUT_MS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_TIMEOUT_MS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new Error(`TEST_COMMAND_TIMEOUT_MS must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`);
  }
  return value;
}
