import { describe, expect, test, vi } from 'vitest';
import type { IMasterAdminRepository, MasterAdminActor } from '../../domain/interfaces/IMasterAdminRepository.js';
import type { DeletedPendingIngestionJobs, IMasterAdminIngestionJobRepository, MasterAdminIngestionJobPage, ReprocessedIngestionJob } from '../../domain/interfaces/IMasterAdminIngestionJobRepository.js';
import { MasterAdminIngestionJobService } from './MasterAdminIngestionJobService.js';

describe('MasterAdminIngestionJobService', () => {
  test('keeps listing read-only and does not reconcile leases as a side effect', async () => {
    const actor: MasterAdminActor = { id: 'master-1', tenantId: 'tenant-master', operatorOrganizationId: 'org-1', role: 'MASTER_ADMIN' };
    const page: MasterAdminIngestionJobPage = {
      jobs: [],
      hasMore: false,
      summary: { total: 0, pending: 0, running: 0, success: 0, failed: 0, cancelled: 0, skipped: 0 },
    };
    const reconcile = vi.fn().mockResolvedValue({ requeued: 0, failed: 0, cancelled: 0 });
    const repository = { list: vi.fn().mockResolvedValue(page), reconcileStaleJobs: reconcile } as unknown as IMasterAdminIngestionJobRepository;
    const adminRepository = { findActor: vi.fn().mockResolvedValue(actor) } as unknown as IMasterAdminRepository;

    await expect(new MasterAdminIngestionJobService(repository, adminRepository).list({ actorUserId: actor.id })).resolves.toEqual(page);

    expect(repository.list).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
  });

  test('deletes pending jobs globally and audits each affected tenant', async () => {
    const audit = vi.fn().mockResolvedValue(undefined);
    const actor: MasterAdminActor = { id: 'master-1', tenantId: 'tenant-master', operatorOrganizationId: 'org-1', role: 'MASTER_ADMIN' };
    const result: DeletedPendingIngestionJobs = {
      deletedCount: 7,
      byTenant: [{ tenantId: 'tenant-a', count: 5 }, { tenantId: 'tenant-b', count: 2 }],
    };
    const repository = { deletePendingJobs: vi.fn().mockResolvedValue(result) } as unknown as IMasterAdminIngestionJobRepository;
    const adminRepository = { findActor: vi.fn().mockResolvedValue(actor), createAuditEvent: audit } as unknown as IMasterAdminRepository;

    const response = await new MasterAdminIngestionJobService(repository, adminRepository).deletePending('master-1');

    expect(response).toEqual(result);
    expect(repository.deletePendingJobs).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a', action: 'MASTER_ADMIN_INGESTION_PENDING_PURGED' }));
  });

  test('rejects global job access for non-master roles', async () => {
    const actor: MasterAdminActor = { id: 'operator-1', tenantId: 'tenant-a', operatorOrganizationId: 'org-1', role: 'OPERATOR_ADMIN' };
    const repository = { list: vi.fn() } as unknown as IMasterAdminIngestionJobRepository;
    const adminRepository = { findActor: vi.fn().mockResolvedValue(actor) } as unknown as IMasterAdminRepository;

    await expect(new MasterAdminIngestionJobService(repository, adminRepository).list({ actorUserId: actor.id })).rejects.toMatchObject({ code: 'AUTHORIZATION_FAILED' });
    expect(repository.list).not.toHaveBeenCalled();
  });

  test('reprocesses an eligible window and records the administrative reason', async () => {
    const actor: MasterAdminActor = { id: 'master-1', tenantId: 'tenant-master', operatorOrganizationId: 'org-1', role: 'MASTER_ADMIN' };
    const result: ReprocessedIngestionJob = {
      originalJobId: 'job-old',
      reusedActiveJob: false,
      job: {
        id: 'job-new', tenantId: 'tenant-a', tenantName: 'Tenant A', tenantSlug: 'tenant-a',
        cloudConnectionId: 'connection-a', connectionName: 'OCI', providerCode: 'oci', sourceType: 'TECHNICAL_METRIC',
        status: 'PENDING', projectionStatus: 'NOT_REQUIRED', projectionAttempts: 0, projectionMaxAttempts: 3,
        attempts: 0, maxAttempts: 3, targetStart: new Date('2026-09-01T00:00:00Z'), targetEnd: new Date('2026-09-01T01:00:00Z'),
        priority: 30, availableAt: new Date('2026-09-21T00:00:00Z'), createdAt: new Date('2026-09-21T00:00:00Z'),
        updatedAt: new Date('2026-09-21T00:00:00Z'),
      },
    };
    const reprocess = vi.fn().mockResolvedValue(result);
    const audit = vi.fn().mockResolvedValue(undefined);
    const repository = { reprocess } as unknown as IMasterAdminIngestionJobRepository;
    const adminRepository = { findActor: vi.fn().mockResolvedValue(actor), createAuditEvent: audit } as unknown as IMasterAdminRepository;

    await expect(new MasterAdminIngestionJobService(repository, adminRepository).reprocess(actor.id, 'job-old', '  Emisión tardía confirmada  ')).resolves.toEqual(result);

    expect(reprocess).toHaveBeenCalledWith('job-old', actor.id, 'Emisión tardía confirmada');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'MASTER_ADMIN_INGESTION_JOB_REPROCESSED',
      entityId: 'job-new',
      tenantId: 'tenant-a',
      metadata: expect.objectContaining({ originalJobId: 'job-old', reason: 'Emisión tardía confirmada' }),
    }));
  });

  test('rejects an empty reprocessing reason before touching the repository', async () => {
    const actor: MasterAdminActor = { id: 'master-1', tenantId: 'tenant-master', operatorOrganizationId: 'org-1', role: 'MASTER_ADMIN' };
    const reprocess = vi.fn();
    const repository = { reprocess } as unknown as IMasterAdminIngestionJobRepository;
    const adminRepository = { findActor: vi.fn().mockResolvedValue(actor) } as unknown as IMasterAdminRepository;

    await expect(new MasterAdminIngestionJobService(repository, adminRepository).reprocess(actor.id, 'job-old', '   ')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(reprocess).not.toHaveBeenCalled();
  });
});
