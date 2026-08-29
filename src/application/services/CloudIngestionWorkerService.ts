import type { CloudIngestionProvider } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type {
  IngestionJobExecutionSummary,
  PrismaCloudIngestionJobRepository,
} from '../../infrastructure/ingestion/PrismaCloudIngestionJobRepository.js';
import type { IngestionJobProgress } from '../../infrastructure/ingestion/PrismaCloudIngestionJobRepository.js';
import { runWithDatabaseContext } from '../../infrastructure/database/tenantContext.js';
import { safeErrorMessage } from '../observability/safeError.js';
import type { MetricsRegistry } from '../observability/MetricsRegistry.js';

export interface CloudIngestionWorkerRunResult {
  readonly processed: boolean;
  readonly jobId?: string;
  readonly providerCode?: string;
  readonly summary?: IngestionJobExecutionSummary;
  readonly errorMessage?: string;
}

export class CloudIngestionWorkerService {
  private readonly providers: ReadonlyMap<string, CloudIngestionProvider>;
  private readonly onSuccessfulIngestion: ((input: { readonly tenantId: string; readonly jobId: string; readonly providerCode: string }) => Promise<void>) | undefined;

  constructor(
    private readonly jobs: PrismaCloudIngestionJobRepository,
    providers: readonly CloudIngestionProvider[],
    onSuccessfulIngestion?: (input: { readonly tenantId: string; readonly jobId: string; readonly providerCode: string }) => Promise<void>,
    private readonly metrics?: MetricsRegistry,
    private readonly heartbeatMs = 60_000,
    private readonly progressUpdateMs = 2_000,
    private readonly defaultConcurrency = 1,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.providerCode, provider]));
    this.onSuccessfulIngestion = onSuccessfulIngestion;
  }

  public async runOnce(workerId: string): Promise<CloudIngestionWorkerRunResult> {
    const startedAt = Date.now();
    try {
      const result = await runWithDatabaseContext({ workerId, role: 'MASTER_ADMIN' }, async () => {
        const job = await this.jobs.claimNextPendingJob(workerId);
        if (job === null) {
          return { processed: false };
        }

        return runWithDatabaseContext(
          { tenantId: job.tenantId, workerId, role: 'MASTER_ADMIN' },
          () => this.processClaimedJob(job, workerId),
        );
      });
      const outcome = !result.processed ? 'empty' : result.errorMessage === undefined ? 'success' : 'error';
      this.metrics?.increment('ingestion_runs_total', { outcome });
      this.metrics?.observe('ingestion_run_duration_ms', Date.now() - startedAt, { outcome });
      if (result.summary !== undefined) {
        this.metrics?.increment('ingestion_api_calls_total', { provider: result.providerCode ?? 'unknown' }, result.summary.apiCallCount);
      }
      return result;
    } catch (error) {
      this.metrics?.increment('ingestion_runs_total', { outcome: 'error' });
      this.metrics?.observe('ingestion_run_duration_ms', Date.now() - startedAt, { outcome: 'error' });
      throw error;
    }
  }

  public async runBatch(workerId: string, concurrency = this.defaultConcurrency): Promise<readonly CloudIngestionWorkerRunResult[]> {
    const slots = Math.max(1, Math.min(16, Math.floor(concurrency)));
    return Promise.all(Array.from({ length: slots }, () => this.runOnce(workerId)));
  }

  private async processClaimedJob(
    job: Awaited<ReturnType<PrismaCloudIngestionJobRepository['claimNextPendingJob']>> & object,
    workerId: string,
  ): Promise<CloudIngestionWorkerRunResult> {
    if (job === null) {
      return { processed: false };
    }

    const startedAt = new Date();
    const provider = this.providers.get(job.connection.providerCode);

    if (provider === undefined) {
      const error = new Error(`No ingestion provider registered for ${job.connection.providerCode}`);
      await this.jobs.failJob(job, error, startedAt, workerId);
      return {
        processed: true,
        jobId: job.id,
        providerCode: job.connection.providerCode,
        errorMessage: safeErrorMessage(error),
      };
    }

    let leaseLost = false;
    const abortController = new AbortController();
    const markLeaseLost = (): void => {
      if (leaseLost) return;
      leaseLost = true;
      this.metrics?.increment('ingestion_job_lease_lost_total', { provider: job.connection.providerCode });
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'ingestion_job_lease_lost',
        jobId: job.id,
        workerId,
        attempt: job.attempt,
      }));
      abortController.abort(new Error('Ingestion job lease was lost'));
    };
    let progress: IngestionJobProgress = {
      phase: 'FETCHING',
      message: 'Consultando datos del proveedor cloud.',
      updatedAt: new Date().toISOString(),
    };
    if (!await this.writeProgress(job.id, workerId, job.attempt, progress)) {
      markLeaseLost();
      return {
        processed: true,
        jobId: job.id,
        providerCode: job.connection.providerCode,
        errorMessage: 'Ingestion job lease was lost before collection',
      };
    }
    if (await this.cancellationRequested(job.id, workerId, job.attempt)) {
      await this.cancel(job, workerId);
      return { processed: true, jobId: job.id, providerCode: job.connection.providerCode, errorMessage: 'Cancelado por el usuario.' };
    }
    const heartbeat = setInterval(() => {
      void this.jobs.refreshJobLease(job.id, workerId, job.attempt)
        .then((renewed) => { if (!renewed) markLeaseLost(); })
        .catch(() => { markLeaseLost(); });
    }, this.heartbeatMs);

    const progressTimer = setInterval(() => {
      void this.writeProgress(job.id, workerId, job.attempt, progress)
        .then((updated) => { if (!updated) markLeaseLost(); })
        .catch(() => { markLeaseLost(); });
    }, this.progressUpdateMs);
    let cancellationPollInFlight = false;
    const cancellationTimer = setInterval(() => {
      if (cancellationPollInFlight || abortController.signal.aborted) return;
      cancellationPollInFlight = true;
      void this.cancellationRequested(job.id, workerId, job.attempt)
        .then((requested) => {
          if (requested) abortController.abort(new Error('Ingestion job cancellation requested'));
        })
        .catch(() => undefined)
        .finally(() => { cancellationPollInFlight = false; });
    }, Math.min(this.progressUpdateMs, 1_000));

    try {
      const result = await provider.collect(job, {
        signal: abortController.signal,
        isCancellationRequested: () => this.cancellationRequested(job.id, workerId, job.attempt),
      });
      if (await this.cancellationRequested(job.id, workerId, job.attempt)) {
        await this.cancel(job, workerId);
        return { processed: true, jobId: job.id, providerCode: job.connection.providerCode, errorMessage: 'Cancelado por el usuario.' };
      }
      if (leaseLost) {
        return {
          processed: true,
          jobId: job.id,
          providerCode: job.connection.providerCode,
          errorMessage: 'Ingestion job lease was lost while collecting provider data',
        };
      }
      progress = {
          phase: 'PERSISTING_RAW',
        message: 'Persistiendo datos normalizados y controles de calidad.',
        providerCalls: result.apiCallCount,
        rowsRead: result.focusRows.length,
        resources: result.resources.length,
        samples: result.metricSamples.length,
        updatedAt: new Date().toISOString(),
      };
      if (!await this.writeProgress(job.id, workerId, job.attempt, progress)) {
        markLeaseLost();
        return {
          processed: true,
          jobId: job.id,
          providerCode: job.connection.providerCode,
          errorMessage: 'Ingestion job lease was lost before persistence',
        };
      }
      const summary = await this.jobs.completeJob(
        job,
        result,
        startedAt,
        workerId,
        (nextProgress) => {
          progress = nextProgress;
          return this.writeProgress(job.id, workerId, job.attempt, nextProgress).then((updated) => {
            if (!updated) {
              markLeaseLost();
              throw new Error('Ingestion job lease was lost while persisting progress');
            }
          });
        },
        async () => abortController.signal.aborted || await this.cancellationRequested(job.id, workerId, job.attempt),
      );
      if (this.onSuccessfulIngestion !== undefined) {
        void this.onSuccessfulIngestion({
          tenantId: job.tenantId,
          jobId: job.id,
          providerCode: job.connection.providerCode,
        }).catch((error: unknown) => {
          console.error(JSON.stringify({
            level: 'warn',
            event: 'post_ingestion_value_reconciliation_failed',
            jobId: job.id,
            tenantId: job.tenantId,
            error: safeErrorMessage(error),
          }));
        });
      }

      return {
        processed: true,
        jobId: job.id,
        providerCode: job.connection.providerCode,
        summary,
      };
    } catch (error) {
      if (leaseLost) {
        return {
          processed: true,
          jobId: job.id,
          providerCode: job.connection.providerCode,
          errorMessage: safeErrorMessage(error),
        };
      }
      if (await this.cancellationRequested(job.id, workerId, job.attempt)) {
        await this.cancel(job, workerId);
      } else {
        await this.jobs.failJob(job, error, startedAt, workerId);
      }
      return {
        processed: true,
        jobId: job.id,
        providerCode: job.connection.providerCode,
        errorMessage: safeErrorMessage(error),
      };
    } finally {
      clearInterval(heartbeat);
      clearInterval(progressTimer);
      clearInterval(cancellationTimer);
    }
  }

  private async writeProgress(
    jobId: string,
    workerId: string,
    attempt: number,
    progress: IngestionJobProgress,
  ): Promise<boolean> {
    if (typeof this.jobs.updateJobProgress === 'function') {
      return this.jobs.updateJobProgress(jobId, workerId, attempt, progress);
    }
    return true;
  }

  private async cancellationRequested(jobId: string, workerId: string, attempt: number): Promise<boolean> {
    return typeof this.jobs.isCancellationRequested === 'function'
      ? this.jobs.isCancellationRequested(jobId, workerId, attempt)
      : false;
  }

  private async cancel(job: Parameters<PrismaCloudIngestionJobRepository['markCancelled']>[0], workerId: string): Promise<void> {
    if (typeof this.jobs.markCancelled === 'function') await this.jobs.markCancelled(job, workerId);
  }
}
