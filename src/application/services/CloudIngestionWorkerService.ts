import type { CloudIngestionProvider } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type {
  IngestionJobExecutionSummary,
  PrismaCloudIngestionJobRepository,
} from '../../infrastructure/ingestion/PrismaCloudIngestionJobRepository.js';
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
        errorMessage: error.message,
      };
    }

    const heartbeatMs = readPositiveIntegerEnv('INGESTION_JOB_HEARTBEAT_MS', 60_000);
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void this.jobs.refreshJobLease(job.id, workerId, job.attempt)
        .then((renewed) => { leaseLost ||= !renewed; })
        .catch(() => { leaseLost = true; });
    }, heartbeatMs);

    try {
      const result = await provider.collect(job);
      if (leaseLost) {
        return {
          processed: true,
          jobId: job.id,
          providerCode: job.connection.providerCode,
          errorMessage: 'Ingestion job lease was lost while collecting provider data',
        };
      }
      const summary = await this.jobs.completeJob(job, result, startedAt, workerId);
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
      await this.jobs.failJob(job, error, startedAt, workerId);
      return {
        processed: true,
        jobId: job.id,
        providerCode: job.connection.providerCode,
        errorMessage: error instanceof Error ? error.message : 'Unknown ingestion worker error',
      };
    } finally {
      clearInterval(heartbeat);
    }
  }
}

function readPositiveIntegerEnv(key: string, defaultValue: number): number {
  const parsed = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
