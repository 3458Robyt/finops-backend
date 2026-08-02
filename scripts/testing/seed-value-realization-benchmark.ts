import 'dotenv/config';

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestingPrismaClient } from '../../src/testing/e2eFixtures.js';

if (process.env['RUN_DB_INTEGRATION_TESTS'] !== 'true') {
  throw new Error('Set RUN_DB_INTEGRATION_TESTS=true and use an isolated TEST_DATABASE_URL.');
}

const prisma = createTestingPrismaClient();
const runId = process.env['VALUE_REALIZATION_BENCHMARK_RUN_ID'] ?? `value-benchmark-${Date.now()}`;
const mainTenantSlug = `e2e-finops-${runId}-main`;
const passwordHash = 'benchmark-only-not-for-login';
const batchSize = 1_000;

try {
  const tenants = await Promise.all(Array.from({ length: 5 }, (_, index) => prisma.tenant.create({
    data: { name: `Value realization benchmark ${runId} ${index + 1}`, slug: `e2e-finops-${runId}-${index + 1}`, status: 'ACTIVE' },
  })));
  const mainTenant = tenants[0]!;
  await prisma.tenant.update({ where: { id: mainTenant.id }, data: { slug: mainTenantSlug } });

  const user = await prisma.user.create({
    data: { tenantId: mainTenant.id, email: `e2e-finops-${runId}@example.test`, name: `Benchmark ${runId}`, passwordHash, role: 'ADMIN', status: 'ACTIVE' },
  });
  const accounts = await Promise.all(tenants.map((tenant, index) => prisma.cloudAccount.create({
    data: { tenantId: tenant.id, provider: index % 2 === 0 ? 'OCI' : 'AWS', externalAccountId: `${runId}-account-${index + 1}`, name: `Benchmark account ${index + 1}`, defaultRegion: index % 2 === 0 ? 'us-ashburn-1' : 'us-east-1', status: 'ACTIVE' },
  })));
  const account = accounts[0]!;
  const recommendations: Prisma.RecommendationCreateManyInput[] = Array.from({ length: 10_000 }, (_, index) => ({
    id: `bench-rec-${runId}-${index}`,
    tenantId: mainTenant.id,
    cloudAccountId: account.id,
    type: index % 2 === 0 ? 'RIGHTSIZING' : 'SCHEDULED_SHUTDOWN',
    status: 'APPROVED',
    severity: index % 10 === 0 ? 'HIGH' : 'MEDIUM',
    title: `Benchmark opportunity ${index}`,
    description: 'Synthetic benchmark record; never use as production data.',
    estimatedMonthlySavings: new Prisma.Decimal(20 + (index % 80)),
    currency: 'USD',
    createdAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000),
  }));
  await insertBatches(prisma, recommendations, (batch) => prisma.recommendation.createMany({ data: batch }));

  const executions: Prisma.RecommendationManualExecutionCreateManyInput[] = [];
  const measurements: Prisma.RecommendationSavingsMeasurementCreateManyInput[] = [];
  const anchor = new Date(Date.UTC(2026, 6, 26, 12));
  for (let index = 0; index < 10_000; index += 1) {
    const recommendationId = `bench-rec-${runId}-${index}`;
    for (let version = 0; version < 2; version += 1) {
      const executionId = `bench-exec-${runId}-${index}-${version}`;
      const executedAt = new Date(anchor.getTime() - (version === 0 ? 60 : 5) * 86_400_000);
      const observationEnd = new Date(executedAt.getTime() + 30 * 86_400_000);
      const verified = version === 0;
      executions.push({
        id: executionId,
        tenantId: mainTenant.id,
        recommendationId,
        userId: user.id,
        status: 'EXECUTED',
        executedAt,
        currency: 'USD',
        observedMonthlySavings: new Prisma.Decimal(verified ? 12 : 0),
      });
      measurements.push({
        id: `bench-measurement-${runId}-${index}-${version}`,
        tenantId: mainTenant.id,
        recommendationId,
        manualExecutionId: executionId,
        requestedByUserId: user.id,
        status: verified ? 'VERIFIED' : 'WAITING_FOR_DATA',
        scope: 'RESOURCE',
        provider: account.provider,
        cloudAccountId: account.id,
        resourceId: `benchmark-resource-${index}`,
        serviceName: 'Compute',
        executedAt,
        baselineStart: new Date(executedAt.getTime() - 30 * 86_400_000),
        baselineEnd: executedAt,
        observationStart: executedAt,
        observationEnd,
        windowDays: 30,
        baselineCoveredDays: 30,
        observationCoveredDays: verified ? 30 : 5,
        coverageRatio: new Prisma.Decimal(verified ? 1 : 0.166667),
        billingSource: 'PROVIDER_API',
        costBasis: 'BILLED',
        currency: 'USD',
        baselineCost: new Prisma.Decimal(100),
        observationCost: new Prisma.Decimal(88),
        baselineDailyCost: new Prisma.Decimal(3.333333),
        observationDailyCost: new Prisma.Decimal(2.933333),
        observedSavings: new Prisma.Decimal(verified ? 12 : 0),
        projectedMonthlySavings: new Prisma.Decimal(verified ? 12 : 0),
        costIncreaseMonthlyAmount: new Prisma.Decimal(0),
        calculationMethod: 'COST_DELTA',
        confidence: new Prisma.Decimal(verified ? 0.95 : 0),
        confidenceLevel: verified ? 'HIGH' : 'LOW',
        technicalValidationStatus: verified ? 'AVAILABLE' : 'NOT_EVALUATED',
        reasons: { source: 'benchmark' },
        formula: { version: 'benchmark-v1' },
        evidence: { source: 'benchmark' },
        evidenceHash: `bench-evidence-${runId}-${index}-${version}`,
        calculationVersion: 'benchmark-v1',
        calculatedAt: verified ? observationEnd : null,
        verifiedAt: verified ? observationEnd : null,
      });
    }
  }
  await insertBatches(prisma, executions, (batch) => prisma.recommendationManualExecution.createMany({ data: batch }));
  await insertBatches(prisma, measurements, (batch) => prisma.recommendationSavingsMeasurement.createMany({ data: batch }));

  const artifact = { runId, tenantId: mainTenant.id, tenantIds: tenants.map((tenant) => tenant.id), recommendations: recommendations.length, measurements: measurements.length };
  const outputFile = resolve('.test-artifacts/perf/value-realization-benchmark-fixtures.json');
  await mkdir(resolve('.test-artifacts/perf'), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ success: true, outputFile, ...artifact }, null, 2));
} finally {
  await prisma.$disconnect();
}

async function insertBatches<T>(client: PrismaClient, rows: readonly T[], insert: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let start = 0; start < rows.length; start += batchSize) {
    await insert(rows.slice(start, start + batchSize));
  }
}
