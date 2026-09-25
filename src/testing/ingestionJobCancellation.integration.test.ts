import { describe, expect, test } from 'vitest';
import { PrismaCloudIngestionReadRepository } from '../infrastructure/repositories/PrismaCloudIngestionReadRepository.js';
import {
  cleanupE2eFixtures,
  createE2eFixtures,
  createTestingPrismaClient,
} from './e2eFixtures.js';

describe('bulk ingestion-job cancellation PostgreSQL integration', () => {
  test.skipIf(process.env['RUN_DB_INTEGRATION_TESTS'] !== 'true')(
    'persists terminal progress and the cancelling actor only for matching pending jobs',
    async () => {
      const prisma = createTestingPrismaClient();
      const runId = `cancel-jobs-${Date.now()}`;
      try {
        const fixtures = await createE2eFixtures(prisma, runId);
        const tenant = fixtures.tenants[0];
        expect(tenant).toBeDefined();
        const [actor, connection] = await Promise.all([
          prisma.user.findFirstOrThrow({ where: { email: fixtures.admin.email }, select: { id: true } }),
          prisma.cloudConnection.findFirstOrThrow({
            where: { tenantId: tenant!.id },
            select: { id: true, providerCode: true, rootExternalId: true, name: true, defaultRegion: true },
          }),
        ]);
        const otherTenant = fixtures.tenants.find((candidate) => candidate.id !== tenant!.id);
        expect(otherTenant).toBeDefined();
        const otherTenantConnection = await prisma.cloudConnection.findFirstOrThrow({
          where: { tenantId: otherTenant!.id },
          select: { id: true },
        });
        const otherConnection = await prisma.cloudConnection.create({
          data: {
            tenantId: tenant!.id,
            providerCode: connection.providerCode,
            rootExternalId: `${connection.rootExternalId}-other`,
            name: `${connection.name} other connection`,
            defaultRegion: connection.defaultRegion,
            metadata: { e2eRunId: runId },
          },
          select: { id: true },
        });
        const targetStart = new Date('2026-09-24T00:00:00.000Z');
        const fixtureContext = { e2eRunId: runId, fixture: true };
        const preexistingPendingMetrics = await prisma.ingestionJob.findMany({
          where: {
            tenantId: tenant!.id,
            cloudConnectionId: connection.id,
            sourceType: 'TECHNICAL_METRIC',
            status: 'PENDING',
          },
          select: { id: true },
        });
        const [pendingMetricA, pendingMetricB, pendingBilling, completedMetric, legacyCancelledMetric,
          otherConnectionPending, otherTenantPending] = await Promise.all([
          createJob(prisma, tenant!.id, connection.id, 'TECHNICAL_METRIC', 'PENDING', actor.id, targetStart, fixtureContext),
          createJob(prisma, tenant!.id, connection.id, 'TECHNICAL_METRIC', 'PENDING', actor.id, addHours(targetStart, 1), fixtureContext),
          createJob(prisma, tenant!.id, connection.id, 'BILLING_EXPORT', 'PENDING', actor.id, targetStart, fixtureContext),
          createJob(prisma, tenant!.id, connection.id, 'TECHNICAL_METRIC', 'SUCCESS', actor.id, addHours(targetStart, 2), fixtureContext),
          createJob(prisma, tenant!.id, connection.id, 'TECHNICAL_METRIC', 'CANCELLED', actor.id, addHours(targetStart, 3), fixtureContext),
          createJob(prisma, tenant!.id, otherConnection.id, 'TECHNICAL_METRIC', 'PENDING', actor.id, targetStart, fixtureContext),
          createJob(prisma, otherTenant!.id, otherTenantConnection.id, 'TECHNICAL_METRIC', 'PENDING', actor.id, targetStart, fixtureContext),
        ]);

        const repository = new PrismaCloudIngestionReadRepository(prisma);
        const updatedCount = await repository.cancelPendingIngestionJobs(
          tenant!.id,
          connection.id,
          'TECHNICAL_METRIC',
          actor.id,
        );
        const expectedCancelledIds = [
          ...preexistingPendingMetrics.map((job) => job.id),
          pendingMetricA.id,
          pendingMetricB.id,
        ];
        const jobs = await prisma.ingestionJob.findMany({
          where: { id: { in: [...expectedCancelledIds, pendingBilling.id, completedMetric.id, legacyCancelledMetric.id,
            otherConnectionPending.id, otherTenantPending.id] } },
          orderBy: { id: 'asc' },
        });

        expect(updatedCount).toBe(expectedCancelledIds.length);
        for (const id of expectedCancelledIds) {
          const job = jobs.find((candidate) => candidate.id === id);
          expect(job?.status).toBe('CANCELLED');
          expect(job?.cancelRequestedByUserId).toBe(actor.id);
          expect(job?.cancelRequestedAt?.toISOString()).toBe(job?.completedAt?.toISOString());
          expect(job?.progress).toMatchObject({
            phase: 'CANCELLED',
            message: 'Trabajo cancelado antes de iniciar.',
          });
          expect((job?.progress as { updatedAt?: string } | null)?.updatedAt).toBe(job?.completedAt?.toISOString());
        }
        expect(jobs.find((job) => job.id === pendingBilling.id)?.status).toBe('PENDING');
        expect(jobs.find((job) => job.id === completedMetric.id)?.status).toBe('SUCCESS');
        expect(jobs.find((job) => job.id === otherConnectionPending.id)?.status).toBe('PENDING');
        expect(jobs.find((job) => job.id === otherTenantPending.id)?.status).toBe('PENDING');
        expect(jobs.find((job) => job.id === legacyCancelledMetric.id)?.progress).toMatchObject({ phase: 'QUEUED' });
        const legacyHistory = await repository.getIngestionJobForTenant(tenant!.id, legacyCancelledMetric.id);
        expect(legacyHistory?.progress).toMatchObject({
          phase: 'CANCELLED',
          message: 'Trabajo cancelado. Detalle histórico no disponible.',
        });
      } finally {
        await cleanupE2eFixtures(prisma, runId);
        await prisma.$disconnect();
      }
    },
    30_000,
  );
});

async function createJob(
  prisma: ReturnType<typeof createTestingPrismaClient>,
  tenantId: string,
  cloudConnectionId: string,
  sourceType: 'TECHNICAL_METRIC' | 'BILLING_EXPORT',
  status: 'PENDING' | 'SUCCESS' | 'CANCELLED',
  requestedByUserId: string,
  targetStart: Date,
  requestContext: { readonly e2eRunId: string; readonly fixture: true },
) {
  const targetEnd = addHours(targetStart, 1);
  return prisma.ingestionJob.create({
    data: {
      tenantId,
      cloudConnectionId,
      sourceType,
      status,
      requestedByUserId,
      targetStart,
      targetEnd,
      requestContext,
      progress: { phase: 'QUEUED', message: 'Fixture job queued.' },
      ...(status !== 'PENDING' ? { completedAt: targetEnd } : {}),
    },
    select: { id: true },
  });
}

function addHours(value: Date, hours: number): Date {
  return new Date(value.getTime() + hours * 60 * 60 * 1000);
}
