import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const destructiveTestsAllowed = process.env.ALLOW_DESTRUCTIVE_TEST_DATABASE === 'true';

if (!databaseUrl || !destructiveTestsAllowed) {
  console.log(JSON.stringify({
    success: true,
    skipped: true,
    reason: 'Integration tests require TEST_DATABASE_URL and ALLOW_DESTRUCTIVE_TEST_DATABASE=true.',
  }, null, 2));
  process.exit(0);
}

const vitestEntry = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));
if (!existsSync(vitestEntry)) {
  console.error('Vitest is not installed; run npm install before executing integration tests.');
  process.exit(1);
}

const testFiles = [
  'src/testing/e2eFixtures.test.ts',
  'src/testing/technicalMetrics.integration.test.ts',
  'src/testing/recommendationAnalysis.integration.test.ts',
  'src/testing/verifiedSavingsMeasurement.integration.test.ts',
  'src/testing/tenantContext.integration.test.ts',
  'src/testing/agentQuality.integration.test.ts',
  'src/testing/agentLearningContext.integration.test.ts',
];

const result = spawnSync(process.execPath, [vitestEntry, 'run', ...testFiles], {
  stdio: 'inherit',
  env: {
    ...process.env,
    RUN_DB_INTEGRATION_TESTS: 'true',
  },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
