import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type {
  DeletedPendingIngestionJobs,
  IMasterAdminIngestionJobRepository,
  MasterAdminIngestionJob,
  MasterAdminIngestionJobFilters,
  MasterAdminIngestionJobPage,
  MasterAdminIngestionJobSummary,
} from '../../domain/interfaces/IMasterAdminIngestionJobRepository.js';
import { toIngestionJobHistoryItem } from './mappers/cloudConnectionMappers.js';

export class PrismaMasterAdminIngestionJobRepository implements IMasterAdminIngestionJobRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async list(input: MasterAdminIngestionJobFilters): Promise<MasterAdminIngestionJobPage> {
    const where = this.buildWhere(input);
    const summaryWhere = input.includeArchived ? {} : { archivedAt: null };
    const [rows, total, grouped] = await Promise.all([
      this.prisma.ingestionJob.findMany({
        where,
        include: jobRelations,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
      }),
      this.prisma.ingestionJob.count({ where: summaryWhere }),
      this.prisma.ingestionJob.groupBy({ by: ['status'], where: summaryWhere, _count: { id: true } }),
    ]);
    const hasMore = rows.length > input.limit;
    const jobs = rows.slice(0, input.limit).map(toAdminJob);
    const counts = new Map(grouped.map((item) => [item.status, item._count.id]));

    return {
      jobs,
      hasMore,
      summary: {
        total,
        pending: counts.get('PENDING') ?? 0,
        running: counts.get('RUNNING') ?? 0,
        success: counts.get('SUCCESS') ?? 0,
        failed: counts.get('FAILED') ?? 0,
        cancelled: counts.get('CANCELLED') ?? 0,
        skipped: counts.get('SKIPPED') ?? 0,
      },
    };
  }

  public async deletePendingJobs(): Promise<DeletedPendingIngestionJobs> {
    return this.prisma.$transaction(async (tx) => {
      const deleted = await tx.$queryRaw<readonly { tenant_id: string }[]>(Prisma.sql`
        DELETE FROM ingestion_jobs
        WHERE status = 'PENDING'
        RETURNING tenant_id
      `);
      const counts = new Map<string, number>();
      for (const row of deleted) counts.set(row.tenant_id, (counts.get(row.tenant_id) ?? 0) + 1);
      return {
        deletedCount: deleted.length,
        byTenant: [...counts.entries()].map(([tenantId, count]) => ({ tenantId, count })),
      };
    });
  }

  public async requestCancellation(jobId: string, userId: string): Promise<MasterAdminIngestionJob | null> {
    let changed = false;
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const pending = await tx.ingestionJob.updateMany({
        where: { id: jobId, status: 'PENDING', archivedAt: null },
        data: {
          status: 'CANCELLED',
          completedAt: now,
          cancelRequestedAt: now,
          cancelRequestedByUserId: userId,
          errorMessage: 'Cancelado por el administrador maestro.',
          progress: { phase: 'CANCELLED', message: 'Trabajo cancelado antes de iniciar.', updatedAt: now.toISOString() },
        },
      });
      if (pending.count > 0) {
        changed = true;
        return;
      }
      const running = await tx.ingestionJob.updateMany({
        where: { id: jobId, status: 'RUNNING', archivedAt: null },
        data: {
          cancelRequestedAt: now,
          cancelRequestedByUserId: userId,
          progress: { phase: 'CANCELLATION_REQUESTED', message: 'Cancelación solicitada por el administrador maestro.', updatedAt: now.toISOString() },
        },
      });
      changed = running.count > 0;
    });
    return changed ? this.findById(jobId) : null;
  }

  public async archive(jobId: string, userId: string): Promise<MasterAdminIngestionJob | null> {
    const result = await this.prisma.ingestionJob.updateMany({
      where: { id: jobId, archivedAt: null, status: { in: ['SUCCESS', 'FAILED', 'CANCELLED', 'SKIPPED'] } },
      data: { archivedAt: new Date(), archivedByUserId: userId },
    });
    return result.count === 0 ? null : this.findById(jobId);
  }

  private buildWhere(input: MasterAdminIngestionJobFilters): Prisma.IngestionJobWhereInput {
    return {
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.sourceType !== undefined ? { sourceType: input.sourceType } : {}),
      ...(input.includeArchived ? {} : { archivedAt: null }),
    };
  }

  private async findById(jobId: string): Promise<MasterAdminIngestionJob | null> {
    const job = await this.prisma.ingestionJob.findUnique({ where: { id: jobId }, include: jobRelations });
    return job === null ? null : toAdminJob(job);
  }
}

const jobRelations = {
  tenant: { select: { name: true, slug: true } },
  cloudConnection: { select: { name: true, providerCode: true, defaultRegion: true } },
  requestedBy: { select: { name: true, email: true } },
} as const;

function toAdminJob(job: Parameters<typeof toIngestionJobHistoryItem>[0] & {
  readonly tenant: { readonly name: string; readonly slug: string };
  readonly cloudConnection: { readonly name: string; readonly providerCode: string; readonly defaultRegion: string | null };
  readonly requestedBy: { readonly name: string; readonly email: string } | null;
}): MasterAdminIngestionJob {
  const base = toIngestionJobHistoryItem(job);
  return {
    ...base,
    tenantId: job.tenantId,
    tenantName: job.tenant.name,
    tenantSlug: job.tenant.slug,
    connectionName: job.cloudConnection.name,
    providerCode: job.cloudConnection.providerCode,
    ...(job.cloudConnection.defaultRegion !== null ? { defaultRegion: job.cloudConnection.defaultRegion } : {}),
    ...(job.requestedBy !== null ? { requestedByUserName: job.requestedBy.name, requestedByUserEmail: job.requestedBy.email } : {}),
  };
}
