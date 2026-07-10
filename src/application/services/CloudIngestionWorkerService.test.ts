import { describe, expect, it, vi } from 'vitest';
import type {
  CloudIngestionJobContext,
  CloudIngestionProvider,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { PrismaCloudIngestionJobRepository } from '../../infrastructure/ingestion/PrismaCloudIngestionJobRepository.js';
import { CloudIngestionWorkerService } from './CloudIngestionWorkerService.js';

function createJob(providerCode = 'oci'): CloudIngestionJobContext {
  return {
    id: 'job-1',
    tenantId: 'tenant-1',
    cloudConnectionId: 'connection-1',
    sourceType: 'TECHNICAL_METRIC',
    targetStart: new Date('2026-06-01T00:00:00.000Z'),
    targetEnd: new Date('2026-06-01T00:30:00.000Z'),
    connection: {
      id: 'connection-1',
      tenantId: 'tenant-1',
      providerCode,
      rootExternalId: 'root-1',
      credentials: [],
    },
  };
}

describe('CloudIngestionWorkerService', () => {
  it('returns processed=false when there is no pending job', async () => {
    const repository = {
      claimNextPendingJob: vi.fn(async () => null),
    } as unknown as PrismaCloudIngestionJobRepository;
    const service = new CloudIngestionWorkerService(repository, []);

    await expect(service.runOnce('worker-1')).resolves.toEqual({ processed: false });
  });

  it('fails the claimed job when no provider is registered for the connection', async () => {
    const job = createJob('missing-provider');
    const failJob = vi.fn(async () => undefined);
    const repository = {
      claimNextPendingJob: vi.fn(async () => job),
      failJob,
    } as unknown as PrismaCloudIngestionJobRepository;
    const service = new CloudIngestionWorkerService(repository, []);

    const result = await service.runOnce('worker-1');

    expect(result).toMatchObject({
      processed: true,
      jobId: 'job-1',
      providerCode: 'missing-provider',
      errorMessage: 'No ingestion provider registered for missing-provider',
    });
    expect(failJob).toHaveBeenCalledWith(job, expect.any(Error), expect.any(Date));
  });

  it('completes a job using the registered provider result', async () => {
    const job = createJob('oci');
    const provider: CloudIngestionProvider = {
      providerCode: 'oci',
      collect: vi.fn(async () => ({
        apiCallCount: 1,
        objectsProcessed: 0,
        focusRows: [],
        resources: [],
        metricSamples: [],
        warnings: ['no datapoints'],
        coverage: { metricDefinitions: 1 },
      })),
    };
    const summary = {
      durationMs: 10,
      providerCode: 'oci',
      sourceType: 'TECHNICAL_METRIC' as const,
      apiCallCount: 1,
      objectsProcessed: 0,
      focusRows: 0,
      focusRowsInserted: 0,
      costMetrics: 0,
      costMetricsInserted: 0,
      resources: 0,
      metricSamples: 0,
      warnings: ['no datapoints'],
      coverage: { metricDefinitions: 1 },
    };
    const completeJob = vi.fn(async () => summary);
    const repository = {
      claimNextPendingJob: vi.fn(async () => job),
      completeJob,
    } as unknown as PrismaCloudIngestionJobRepository;
    const service = new CloudIngestionWorkerService(repository, [provider]);

    const result = await service.runOnce('worker-1');

    expect(provider.collect).toHaveBeenCalledWith(job);
    expect(completeJob).toHaveBeenCalledWith(job, expect.any(Object), expect.any(Date));
    expect(result).toEqual({
      processed: true,
      jobId: 'job-1',
      providerCode: 'oci',
      summary,
    });
  });
});
