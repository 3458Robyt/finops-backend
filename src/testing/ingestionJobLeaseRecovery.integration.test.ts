import { describe, expect, test } from 'vitest';
import { PrismaIngestionJobLeaseReconciler } from '../infrastructure/ingestion/PrismaIngestionJobLeaseReconciler.js';
import { cleanupE2eFixtures, createE2eFixtures, createTestingPrismaClient } from './e2eFixtures.js';

describe('ingestion lease recovery PostgreSQL integration', () => {
  test.skipIf(process.env['RUN_DB_INTEGRATION_TESTS'] !== 'true')(
    'records bounded recovery history, lease timing, attempt and last progress',
    async () => {
      const prisma = createTestingPrismaClient();
      const runId = `lease-recovery-${Date.now()}`;
      try {
        const fixtures = await createE2eFixtures(prisma, runId);
        const tenant = fixtures.tenants[0];
        expect(tenant).toBeDefined();
        const connection = await prisma.cloudConnection.findFirstOrThrow({
          where: { tenantId: tenant!.id },
          select: { id: true },
        });
        const now = new Date('2026-09-26T12:00:00.000Z');
        const lastHeartbeatAt = new Date(now.getTime() - 8 * 60_000);
        const attemptStartedAt = new Date(now.getTime() - 25 * 60_000);
        const lastProgress = {
          phase: 'FETCHING',
          message: 'Consultando proveedor: 4 llamadas, 18 muestras.',
          providerCalls: 4,
          samples: 18,
          updatedAt: lastHeartbeatAt.toISOString(),
        };
        const shared = {
          tenantId: tenant!.id,
          cloudConnectionId: connection.id,
          sourceType: 'TECHNICAL_METRIC' as const,
          status: 'RUNNING' as const,
          targetStart: new Date('2026-09-20T00:00:00.000Z'),
          targetEnd: new Date('2026-09-20T01:00:00.000Z'),
          startedAt: attemptStartedAt,
          lockedAt: lastHeartbeatAt,
          lockedBy: `worker-${runId}`,
          requestContext: { e2eRunId: runId, fixture: true },
          progress: lastProgress,
        };
        const failedJob = await prisma.ingestionJob.create({
          data: {
            ...shared,
            attempts: 3,
            maxAttempts: 3,
            resultSummary: {
              preserved: true,
              leaseRecoveryHistory: Array.from({ length: 12 }, (_, sequence) => ({ sequence })),
            },
          },
          select: { id: true },
        });
        const requeuedJob = await prisma.ingestionJob.create({
          data: {
            ...shared,
            targetStart: new Date('2026-09-20T02:00:00.000Z'),
            targetEnd: new Date('2026-09-20T03:00:00.000Z'),
            attempts: 1,
            maxAttempts: 3,
          },
          select: { id: true },
        });
        const cancelledJob = await prisma.ingestionJob.create({
          data: {
            ...shared,
            targetStart: new Date('2026-09-20T04:00:00.000Z'),
            targetEnd: new Date('2026-09-20T05:00:00.000Z'),
            attempts: 1,
            maxAttempts: 3,
            cancelRequestedAt: new Date(now.getTime() - 2 * 60_000),
          },
          select: { id: true },
        });

        const result = await new PrismaIngestionJobLeaseReconciler().reconcile(prisma, 300_000, now);
        expect(result).toEqual({ cancelled: 1, failed: 1, requeued: 1 });

        const [failed, requeued, cancelled] = await Promise.all([
          prisma.ingestionJob.findUniqueOrThrow({ where: { id: failedJob.id } }),
          prisma.ingestionJob.findUniqueOrThrow({ where: { id: requeuedJob.id } }),
          prisma.ingestionJob.findUniqueOrThrow({ where: { id: cancelledJob.id } }),
        ]);
        expect(failed.status).toBe('FAILED');
        expect(failed.errorMessage).toContain('la causa inicial no quedó registrada');
        const failedSummary = asRecord(failed.resultSummary);
        const failedHistory = asRecords(failedSummary['leaseRecoveryHistory']);
        expect(failedSummary['preserved']).toBe(true);
        expect(failedHistory).toHaveLength(10);
        expect(failedHistory[0]?.['sequence']).toBe(3);
        expect(failedHistory.at(-1)).toMatchObject({
          action: 'FAILED',
          reason: 'retry_attempts_exhausted',
          attempt: 3,
          maxAttempts: 3,
          leaseDurationMs: 300_000,
          lastProgress,
        });
        expect(new Date(String(failedHistory.at(-1)?.['lastHeartbeatAt'])).toISOString()).toBe(lastHeartbeatAt.toISOString());
        expect(new Date(String(failedHistory.at(-1)?.['attemptStartedAt'])).toISOString()).toBe(attemptStartedAt.toISOString());
        expect(new Date(String(failedHistory.at(-1)?.['leaseExpiredAt'])).toISOString())
          .toBe(new Date(lastHeartbeatAt.getTime() + 300_000).toISOString());
        expect(requeued.status).toBe('PENDING');
        expect(asRecords(asRecord(requeued.resultSummary)['leaseRecoveryHistory']).at(-1)).toMatchObject({
          action: 'REQUEUED', attempt: 1, maxAttempts: 3,
        });
        expect(cancelled.status).toBe('CANCELLED');
        expect(asRecords(asRecord(cancelled.resultSummary)['leaseRecoveryHistory']).at(-1)).toMatchObject({
          action: 'CANCELLED', reason: 'cancel_requested_while_lease_expired', attempt: 1,
        });
      } finally {
        await cleanupE2eFixtures(prisma, runId);
        await prisma.$disconnect();
      }
    },
    30_000,
  );
});

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => (
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
  )) : [];
}
