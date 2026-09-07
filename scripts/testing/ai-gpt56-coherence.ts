import 'dotenv/config';

import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const expectedModel = process.env['AI_EXPECTED_MODEL'] ?? 'gpt-5.6-luna';
const runCount = 3;

if (process.env['AI_LIVE_TESTS'] !== 'true') {
  console.log(JSON.stringify({
    success: true,
    skipped: true,
    reason: 'Set AI_LIVE_TESTS=true to run the three isolated GPT-5.6 Luna canaries.',
    expectedModel,
  }, null, 2));
  process.exit(0);
}

const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
const results: Array<{
  readonly attempt: number;
  readonly status: 'PASSED' | 'FAILED';
  readonly durationMs: number;
  readonly error?: string;
}> = [];

for (let attempt = 1; attempt <= runCount; attempt += 1) {
  const startedAt = Date.now();
  try {
    await execFileAsync(process.execPath, [tsxCli, 'scripts/testing/ai-live-canary.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AI_LIVE_TESTS: 'true',
        AI_EXPECTED_MODEL: expectedModel,
        E2E_RUN_ID: `gpt56-coherence-${Date.now()}-${attempt}`,
      },
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    results.push({ attempt, status: 'PASSED', durationMs: Date.now() - startedAt });
  } catch (error: unknown) {
    results.push({
      attempt,
      status: 'FAILED',
      durationMs: Date.now() - startedAt,
      error: redactError(error),
    });
  }
}

const output = {
  success: results.every((result) => result.status === 'PASSED'),
  generatedAt: new Date().toISOString(),
  expectedModel,
  requiredConsecutiveRuns: runCount,
  results,
};
await mkdir(resolve('.test-artifacts/ai-audit'), { recursive: true });
const outputFile = resolve(`.test-artifacts/ai-audit/gpt56-coherence-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(outputFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({ ...output, outputFile }, null, 2));
if (!output.success) process.exitCode = 1;

function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:sk|nvapi)-[A-Za-z0-9._-]+/gi, '[REDACTED_AI_KEY]')
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1[REDACTED]@')
    .slice(0, 500);
}
