import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTestingPrismaClient } from '../../src/testing/e2eFixtures.js';
import { PrismaValueRealizationRepository } from '../../src/infrastructure/repositories/PrismaValueRealizationRepository.js';

if (process.env['RUN_DB_INTEGRATION_TESTS'] !== 'true') {
  throw new Error('Set RUN_DB_INTEGRATION_TESTS=true and use an isolated TEST_DATABASE_URL.');
}

const prisma = createTestingPrismaClient();
const tenantId = process.env['VALUE_REALIZATION_BENCHMARK_TENANT_ID'];
if (tenantId === undefined || tenantId.trim() === '') throw new Error('VALUE_REALIZATION_BENCHMARK_TENANT_ID is required.');
const repository = new PrismaValueRealizationRepository(prisma);
const measurements = await prisma.recommendationSavingsMeasurement.count({ where: { tenantId } });
const recommendations = await prisma.recommendation.count({ where: { tenantId } });
if (recommendations < 10_000 || measurements < 20_000) {
  throw new Error(`Benchmark requires at least 10,000 recommendations and 20,000 measurements; found ${recommendations}/${measurements}. Seed an isolated benchmark schema first.`);
}

const startedAt = Date.now();
const summary = await repository.getSummary({ tenantId });
const summaryMs = Date.now() - startedAt;
const pageStartedAt = Date.now();
const page = await repository.listItems({ tenantId, pageSize: 100 });
const pageMs = Date.now() - pageStartedAt;
const exportStartedAt = Date.now();
const exported = await repository.listItemsForExport({ tenantId, pageSize: 10_000 });
const exportMs = Date.now() - exportStartedAt;
const result = { generatedAt: new Date().toISOString(), recommendations, measurements, summaryMs, pageMs, exportMs, returnedPage: page.items.length, returnedExport: exported.length, summary };
await mkdir(resolve('.test-artifacts/perf'), { recursive: true });
const outputFile = resolve('.test-artifacts/perf/value-realization-latest.json');
await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ success: true, outputFile, ...result }, null, 2));
await prisma.$disconnect();
