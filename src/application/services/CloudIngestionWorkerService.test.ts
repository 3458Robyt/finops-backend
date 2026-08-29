import { describe, expect, it, vi } from 'vitest';
import type {
  CloudIngestionJobContext,
  CloudIngestionProvider,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { PrismaCloudIngestionJobRepository } from '../../infrastructure/ingestion/PrismaCloudIngestionJobRepository.js';
import { CloudIngestionWorkerService } from './CloudIngestionWorkerService.js';

function createJob(providerCode = 'oci', id = 'job-1'): CloudIngestionJobContext {
  return {
    id,
    tenantId: 'tenant-1',
    cloudConnectionId: 'connection-1',
    sourceType: 'TECHNICAL_METRIC',
    targetStart: new Date('2026-06-01T00:00:00.000Z'),
    targetEnd: new Date('2026-06-01T00:30:00.000Z'),
    attempt: 1,
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
    expect(failJob).toHaveBeenCalledWith(job, expect.any(Error), expect.any(Date), 'worker-1');
  });

  it('completes a job using the registered provider result', async () => {
    const job = createJob('oci');
    const provider: CloudIngestionProvider = {
      providerCode: 'oci',
      validate: vi.fn(async () => ({ providerCode: 'oci', capabilities: [] })),
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

    expect(provider.collect).toHaveBeenCalledWith(job, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(completeJob).toHaveBeenCalledWith(job, expect.any(Object), expect.any(Date), 'worker-1', expect.any(Function), expect.any(Function));
    expect(result).toEqual({
      processed: true,
      jobId: 'job-1',
      providerCode: 'oci',
      summary,
    });
  });

  it('drains multiple claimed jobs concurrently when batch slots are available', async () => {
    const jobs = [createJob('oci', 'job-1'), createJob('oci', 'job-2')];
    let active = 0;
    let peak = 0;
    const result = {
      apiCallCount: 1,
      objectsProcessed: 0,
      focusRows: [],
      resources: [],
      metricSamples: [],
      warnings: [],
      coverage: {},
    };
    const provider: CloudIngestionProvider = {
      providerCode: 'oci',
      validate: vi.fn(async () => ({ providerCode: 'oci', capabilities: [] })),
      collect: vi.fn(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return result;
      }),
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
      warnings: [],
      coverage: {},
    };
    const repository = {
      claimNextPendingJob: vi.fn(async () => jobs.shift() ?? null),
      completeJob: vi.fn(async () => summary),
    } as unknown as PrismaCloudIngestionJobRepository;
    const service = new CloudIngestionWorkerService(repository, [provider]);

    const outcomes = await service.runBatch('worker-1', 2);

    expect(outcomes.filter((outcome) => outcome.processed)).toHaveLength(2);
    expect(peak).toBe(2);
  });

  it('aborts a provider collection when a running job is cancelled', async () => {
    const job = createJob('oci');
    let cancellationChecks = 0;
    const isCancellationRequested = vi.fn(async () => {
      cancellationChecks += 1;
      return cancellationChecks > 1;
    });
    const markCancelled = vi.fn(async () => true);
    const provider: CloudIngestionProvider = {
      providerCode: 'oci',
      validate: vi.fn(async () => ({ providerCode: 'oci', capabilities: [] })),
      collect: vi.fn(async (_job, options) => new Promise((_, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })),
    };
    const repository = {
      claimNextPendingJob: vi.fn(async () => job),
      isCancellationRequested,
      markCancelled,
    } as unknown as PrismaCloudIngestionJobRepository;
    const service = new CloudIngestionWorkerService(repository, [provider], undefined, undefined, 60_000, 5, 1);

    const result = await service.runOnce('worker-1');

    expect(markCancelled).toHaveBeenCalledWith(job, 'worker-1');
    expect(result).toMatchObject({ processed: true, jobId: job.id, errorMessage: 'aborted' });
  });

  it('does not collect when the lease is already lost during initial progress update', async () => {
    const job = createJob('oci');
    const collect = vi.fn();
    const provider: CloudIngestionProvider = {
      providerCode: 'oci',
      validate: vi.fn(async () => ({ providerCode: 'oci', capabilities: [] })),
      collect,
    };
    const repository = {
      claimNextPendingJob: vi.fn(async () => job),
      updateJobProgress: vi.fn(async () => false),
    } as unknown as PrismaCloudIngestionJobRepository;
    const service = new CloudIngestionWorkerService(repository, [provider]);

    await expect(service.runOnce('worker-1')).resolves.toMatchObject({
      processed: true,
      jobId: job.id,
      errorMessage: 'Ingestion job lease was lost before collection',
    });
    expect(collect).not.toHaveBeenCalled();
  });
});
