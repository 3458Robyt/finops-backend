import { defineConfig } from 'vitest/config';

const excludeIntegrationTests = process.env['RUN_DB_INTEGRATION_TESTS'] !== 'true';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/**',
      '**/downloads/**',
      '**/src/generated/**',
      ...(excludeIntegrationTests ? ['**/src/testing/**/*.integration.test.ts'] : []),
    ],
  },
});
