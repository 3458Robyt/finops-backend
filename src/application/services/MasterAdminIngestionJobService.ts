import { AuthorizationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import type { IMasterAdminRepository, MasterAdminActor } from '../../domain/interfaces/IMasterAdminRepository.js';
import type {
  DeletedPendingIngestionJobs,
  IMasterAdminIngestionJobRepository,
  MasterAdminIngestionJob,
  MasterAdminIngestionJobPage,
  ReconciledIngestionJobs,
} from '../../domain/interfaces/IMasterAdminIngestionJobRepository.js';
import type { IngestionJobStatus, IngestionSourceType } from '../../domain/models/CloudConnection.js';
import { requirePermission } from '../../domain/security/AuthorizationPolicy.js';

export interface MasterAdminIngestionJobListCommand {
  readonly actorUserId: string;
  readonly tenantId?: string;
  readonly status?: IngestionJobStatus;
  readonly sourceType?: IngestionSourceType;
  readonly includeArchived?: boolean;
  readonly limit?: number;
}

export class MasterAdminIngestionJobService {
  public constructor(
    private readonly repository: IMasterAdminIngestionJobRepository,
    private readonly masterAdminRepository: IMasterAdminRepository,
  ) {}

  public async list(command: MasterAdminIngestionJobListCommand): Promise<MasterAdminIngestionJobPage> {
    await this.requireMasterAdmin(command.actorUserId);
    const limit = this.normalizeLimit(command.limit);
    return this.repository.list({
      ...(command.tenantId !== undefined ? { tenantId: command.tenantId } : {}),
      ...(command.status !== undefined ? { status: command.status } : {}),
      ...(command.sourceType !== undefined ? { sourceType: command.sourceType } : {}),
      includeArchived: command.includeArchived === true,
      limit,
    });
  }

  public async reconcileStale(actorUserId: string): Promise<ReconciledIngestionJobs> {
    const actor = await this.requireMasterAdmin(actorUserId);
    const result = await this.repository.reconcileStaleJobs?.() ?? { requeued: 0, failed: 0, cancelled: 0 };
    if (result.requeued > 0 || result.failed > 0 || result.cancelled > 0) {
      await this.masterAdminRepository.createAuditEvent({
        tenantId: actor.tenantId,
        actorUserId: actor.id,
        action: 'MASTER_ADMIN_INGESTION_LEASES_RECONCILED',
        entityType: 'IngestionJob',
        metadata: { ...result, scope: 'ALL_TENANTS' },
      });
    }
    return result;
  }

  public async deletePending(actorUserId: string): Promise<DeletedPendingIngestionJobs> {
    const actor = await this.requireMasterAdmin(actorUserId);
    const result = await this.repository.deletePendingJobs();
    await this.auditDeletion(actor, result);
    return result;
  }

  public async cancel(actorUserId: string, jobId: string): Promise<MasterAdminIngestionJob> {
    const actor = await this.requireMasterAdmin(actorUserId);
    const job = await this.repository.requestCancellation(jobId, actor.id);
    if (job === null) throw new FinOpsBaseError('El trabajo no existe o ya no puede cancelarse.', 'NOT_FOUND');
    await this.masterAdminRepository.createAuditEvent({
      tenantId: job.tenantId,
      actorUserId: actor.id,
      action: 'MASTER_ADMIN_INGESTION_JOB_CANCELLED',
      entityType: 'IngestionJob',
      entityId: job.id,
      metadata: { sourceType: job.sourceType, status: job.status },
    });
    return job;
  }

  public async archive(actorUserId: string, jobId: string): Promise<MasterAdminIngestionJob> {
    const actor = await this.requireMasterAdmin(actorUserId);
    const job = await this.repository.archive(jobId, actor.id);
    if (job === null) throw new FinOpsBaseError('Solo se pueden archivar trabajos terminados.', 'VALIDATION_ERROR');
    await this.masterAdminRepository.createAuditEvent({
      tenantId: job.tenantId,
      actorUserId: actor.id,
      action: 'MASTER_ADMIN_INGESTION_JOB_ARCHIVED',
      entityType: 'IngestionJob',
      entityId: job.id,
      metadata: { sourceType: job.sourceType, status: job.status },
    });
    return job;
  }

  private async requireMasterAdmin(userId: string): Promise<MasterAdminActor> {
    const actor = await this.masterAdminRepository.findActor(userId);
    if (actor === null) throw new AuthorizationError('No se encontró el usuario autenticado');
    requirePermission(actor.role, 'TENANT_MANAGE', 'Solo el administrador maestro puede gestionar la consola global de jobs');
    return actor;
  }

  private async auditDeletion(actor: MasterAdminActor, result: DeletedPendingIngestionJobs): Promise<void> {
    if (result.byTenant.length === 0) {
      await this.masterAdminRepository.createAuditEvent({
        tenantId: actor.tenantId,
        actorUserId: actor.id,
        action: 'MASTER_ADMIN_INGESTION_PENDING_PURGE_EMPTY',
        entityType: 'IngestionJob',
        metadata: { deletedCount: 0, scope: 'ALL_TENANTS' },
      });
      return;
    }
    await Promise.all(result.byTenant.map((item) => this.masterAdminRepository.createAuditEvent({
      tenantId: item.tenantId,
      actorUserId: actor.id,
      action: 'MASTER_ADMIN_INGESTION_PENDING_PURGED',
      entityType: 'IngestionJob',
      metadata: { deletedCount: item.count, totalDeletedCount: result.deletedCount, scope: 'ALL_TENANTS', destructive: true },
    })));
  }

  private normalizeLimit(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) return 100;
    return Math.min(200, Math.max(1, Math.trunc(value)));
  }
}
