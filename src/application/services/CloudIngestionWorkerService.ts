import type { CloudIngestionProvider } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type {
  IngestionJobExecutionSummary,
  PrismaCloudIngestionJobRepository,
} from '../../infrastructure/ingestion/PrismaCloudIngestionJobRepository.js';

export interface CloudIngestionWorkerRunResult {
  readonly processed: boolean;
  readonly jobId?: string;
  readonly providerCode?: string;
  readonly summary?: IngestionJobExecutionSummary;
  readonly errorMessage?: string;
}

export class CloudIngestionWorkerService {
  private readonly providers: ReadonlyMap<string, CloudIngestionProvider>;

  constructor(
    private readonly jobs: PrismaCloudIngestionJobRepository,
    providers: readonly CloudIngestionProvider[],
  ) {
    this.providers = new Map(providers.map((provider) => [provider.providerCode, provider]));
  }

  public async runOnce(workerId: string): Promise<CloudIngestionWorkerRunResult> {
    const job = await this.jobs.claimNextPendingJob(workerId);

    if (job === null) {
      return { processed: false };
    }

    const startedAt = new Date();
    const provider = this.providers.get(job.connection.providerCode);

    if (provider === undefined) {
      const error = new Error(`No ingestion provider registered for ${job.connection.providerCode}`);
      await this.jobs.failJob(job, error, startedAt);
      return {
        processed: true,
        jobId: job.id,
        providerCode: job.connection.providerCode,
        errorMessage: error.message,
      };
    }

    try {
      const result = await provider.collect(job);
      const summary = await this.jobs.completeJob(job, result, startedAt);

      return {
        processed: true,
        jobId: job.id,
        providerCode: job.connection.providerCode,
        summary,
      };
    } catch (error) {
      await this.jobs.failJob(job, error, startedAt);
      return {
        processed: true,
        jobId: job.id,
        providerCode: job.connection.providerCode,
        errorMessage: error instanceof Error ? error.message : 'Unknown ingestion worker error',
      };
    }
  }
}
