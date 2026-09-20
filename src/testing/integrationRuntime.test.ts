import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertIntegrationSchema, createIntegrationPool, runIntegrationCommand } from '../../scripts/testing/integrationRuntime.js';

describe('isolated integration runtime', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts only the dedicated e2e schema namespace', () => {
    expect(() => assertIntegrationSchema('finops_e2e_runtime')).not.toThrow();
    expect(() => assertIntegrationSchema('public')).toThrow();
    expect(() => assertIntegrationSchema('finops_e2e_runtime; DROP SCHEMA public')).toThrow();
  });

  it('rejects remote databases at the shared pool boundary', () => {
    expect(() => createIntegrationPool('postgresql://user:password@db.example.com:5432/postgres')).toThrow(
      'Refusing destructive integration tests against remote database host db.example.com',
    );
  });

  it('executes a command and captures its output', async () => {
    const result = await runIntegrationCommand(
      process.execPath,
      ['-e', 'process.stdout.write("integration-ok")'],
      {},
    );
    expect(result.stdout).toBe('integration-ok');
  });

  it('rejects unsafe process timeout configuration', async () => {
    vi.stubEnv('TEST_COMMAND_TIMEOUT_MS', '29999');
    await expect(runIntegrationCommand(process.execPath, ['-e', ''], {})).rejects.toThrow(
      'TEST_COMMAND_TIMEOUT_MS must be an integer between 30000 and 600000.',
    );
  });
});
