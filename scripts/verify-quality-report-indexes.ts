import 'dotenv/config';

import { Prisma } from '../src/generated/prisma/client.js';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';

const expectedIndexes = [
  'recommendations_tenant_id_created_at_id_idx',
  'ai_context_traces_tenant_id_created_at_id_idx',
] as const;

async function main(): Promise<void> {
  const prisma = getPrismaClient();
  try {
    const indexes = await prisma.$queryRaw<readonly { readonly indexname: string }[]>(Prisma.sql`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (${Prisma.join(expectedIndexes)})
      ORDER BY indexname
    `);
    const tenantRows = await prisma.$queryRaw<readonly { readonly id: string }[]>(Prisma.sql`
      SELECT id
      FROM tenants
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `);
    const tenantId = tenantRows[0]?.id ?? '__no_tenant__';
    const periodStart = new Date('2025-01-01T00:00:00.000Z');
    const periodEnd = new Date('2027-01-01T00:00:00.000Z');
    const recommendationPlan = await explainRecommendationQuery(prisma, tenantId, periodStart, periodEnd);
    const tracePlan = await explainTraceQuery(prisma, tenantId, periodStart, periodEnd);
    const actualIndexes = indexes.map((row) => row.indexname);
    const missingIndexes = expectedIndexes.filter((indexName) => !actualIndexes.includes(indexName));

    console.log(JSON.stringify({
      indexes: actualIndexes,
      missingIndexes,
      recommendationPlan,
      tracePlan,
      tenantSampleAvailable: tenantRows.length > 0,
    }, null, 2));

    if (missingIndexes.length > 0) {
      throw new Error(`Missing quality report indexes: ${missingIndexes.join(', ')}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function explainRecommendationQuery(
  prisma: ReturnType<typeof getPrismaClient>,
  tenantId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<readonly string[]> {
  const rows = await prisma.$queryRaw<readonly { readonly ['QUERY PLAN']: string }[]>(Prisma.sql`
    EXPLAIN (COSTS OFF, FORMAT TEXT)
    SELECT r.id
    FROM recommendations r
    WHERE r.tenant_id = ${tenantId}
      AND r.created_at >= ${periodStart}
      AND r.created_at < ${periodEnd}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT 1001
  `);
  return rows.map((row) => row['QUERY PLAN']);
}

async function explainTraceQuery(
  prisma: ReturnType<typeof getPrismaClient>,
  tenantId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<readonly string[]> {
  const rows = await prisma.$queryRaw<readonly { readonly ['QUERY PLAN']: string }[]>(Prisma.sql`
    EXPLAIN (COSTS OFF, FORMAT TEXT)
    SELECT trace.id
    FROM ai_context_traces trace
    WHERE trace.tenant_id = ${tenantId}
      AND trace.created_at >= ${periodStart}
      AND trace.created_at < ${periodEnd}
    ORDER BY trace.created_at DESC, trace.id DESC
    LIMIT 1001
  `);
  return rows.map((row) => row['QUERY PLAN']);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Quality report index verification failed');
  process.exit(1);
});
