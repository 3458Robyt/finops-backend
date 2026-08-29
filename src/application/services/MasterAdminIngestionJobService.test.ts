import { describe, expect, test, vi } from 'vitest';
import type { IMasterAdminRepository, MasterAdminActor } from '../../domain/interfaces/IMasterAdminRepository.js';
import type { DeletedPendingIngestionJobs, IMasterAdminIngestionJobRepository, MasterAdminIngestionJobPage } from '../../domain/interfaces/IMasterAdminIngestionJobRepository.js';
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
});
