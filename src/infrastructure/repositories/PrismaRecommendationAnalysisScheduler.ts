import type { IRecommendationAnalysisRunRepository } from '../../domain/interfaces/IRecommendationAnalysisRunRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

export async function queueRecommendationAnalysisAfterIngestion(
  prisma: PrismaClient,
  repository: IRecommendationAnalysisRunRepository,
  cooldownMinutes: number,
): Promise<number> {
  const cooldownStart = new Date(Date.now() - Math.max(cooldownMinutes, 0) * 60_000);
  const tenants = await prisma.$queryRaw<{ tenant_id: string }[]>`
    SELECT DISTINCT job."tenant_id"
    FROM "ingestion_jobs" job
    WHERE job."status" = 'SUCCESS'
      AND job."completed_at" IS NOT NULL
      AND job."completed_at" <= ${cooldownStart}
      AND NOT EXISTS (
        SELECT 1
        FROM "recommendation_analysis_runs" run
        WHERE run."tenant_id" = job."tenant_id"
          AND run."created_at" >= job."completed_at"
      )
    ORDER BY job."tenant_id"
    LIMIT 20
  `;

  for (const tenant of tenants) {
    await repository.queue({
      tenantId: tenant.tenant_id,
      trigger: 'POST_INGESTION',
      scope: 'TENANT',
    });
  }
  return tenants.length;
}
