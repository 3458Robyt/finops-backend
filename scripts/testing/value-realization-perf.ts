import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTestingPrismaClient } from '../../src/testing/e2eFixtures.js';
import { PrismaValueRealizationRepository } from '../../src/infrastructure/repositories/PrismaValueRealizationRepository.js';
import { Prisma } from '../../src/generated/prisma/client.js';

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
const explainRows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
  EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
  WITH latest_executions AS (
    SELECT me.id, me.recommendation_id, me.created_at,
           ROW_NUMBER() OVER (PARTITION BY me.recommendation_id ORDER BY me.created_at DESC, me.id DESC) AS execution_rn
    FROM recommendation_manual_executions me
    WHERE me.tenant_id = ${tenantId}
  ), latest_measurements AS (
    SELECT m.id, m.manual_execution_id, m.status, m.created_at,
           ROW_NUMBER() OVER (
             PARTITION BY m.manual_execution_id
             ORDER BY CASE WHEN m.status = 'VERIFIED' THEN 0 WHEN m.status = 'REJECTED' THEN 2 ELSE 1 END,
                      m.created_at DESC, m.id DESC
           ) AS measurement_rn
    FROM recommendation_savings_measurements m
    WHERE m.tenant_id = ${tenantId}
  )
  SELECT COUNT(*)
  FROM recommendations r
  INNER JOIN cloud_accounts ca ON ca.id = r.cloud_account_id AND ca.tenant_id = r.tenant_id
  LEFT JOIN latest_executions le ON le.recommendation_id = r.id AND le.execution_rn = 1
  LEFT JOIN latest_measurements lm ON lm.manual_execution_id = le.id AND lm.measurement_rn = 1
  WHERE r.tenant_id = ${tenantId}
`);
const explainPlan = explainRows[0]?.['QUERY PLAN'];
const result = { generatedAt: new Date().toISOString(), recommendations, measurements, summaryMs, pageMs, exportMs, returnedPage: page.items.length, returnedExport: exported.length, explainExecutionMs: findExplainNumber(explainPlan, 'Execution Time'), summary, explainPlan };
await mkdir(resolve('.test-artifacts/perf'), { recursive: true });
const outputFile = resolve('.test-artifacts/perf/value-realization-latest.json');
await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ success: true, outputFile, ...result }, null, 2));
await prisma.$disconnect();

function findExplainNumber(value: unknown, key: string): number | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findExplainNumber(item, key);
      if (found !== undefined) return found;
    }
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const direct = record[key];
    if (typeof direct === 'number') return direct;
    for (const child of Object.values(record)) {
      const found = findExplainNumber(child, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
