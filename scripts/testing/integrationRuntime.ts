import { execFile, type ChildProcess } from 'node:child_process';
import { Pool } from 'pg';

const DEFAULT_TIMEOUT_MS = 180_000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

export interface IntegrationCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export function createIntegrationPool(connectionString: string, schema?: string): Pool {
  return new Pool({
    connectionString,
    options: [
      schema === undefined ? undefined : `-c search_path=${schema}`,
      '-c timezone=UTC',
    ].filter((option): option is string => option !== undefined).join(' '),
    connectionTimeoutMillis: 10_000,
    statement_timeout: integrationTimeoutMs(),
  });
}

export async function runIntegrationCommand(
  command: string,
  args: readonly string[],
  overrides: NodeJS.ProcessEnv,
): Promise<IntegrationCommandResult> {
  const timeoutMs = integrationTimeoutMs();
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    const child = execFile(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...overrides },
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (timedOut) {
        reject(Object.assign(new Error(`Integration command exceeded ${timeoutMs} ms.`), { code: 'ETIMEDOUT' }));
      } else if (error !== null) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
    timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);
    timeout.unref();
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

function terminateProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    const killer = execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    killer.unref();
    return;
  }
  child.kill('SIGTERM');
}
