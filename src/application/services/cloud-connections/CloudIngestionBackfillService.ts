import type {
  ICloudConnectionRepository,
  IngestionJobSummary,
} from '../../../domain/interfaces/ICloudConnectionRepository.js';
import { FinOpsBaseError } from '../../../domain/errors/errors.js';
import { buildBackfillWindows, currentMinute } from '../cloudConnectionPolicies.js';
import type {
  QueueTechnicalBackfillInput,
  TechnicalBackfillResult,
  TechnicalBackfillWindow,
} from './CloudConnectionContracts.js';

/** Queues bounded, idempotent technical-metric windows for a cloud connection. */
export class CloudIngestionBackfillService {
  constructor(private readonly repository: ICloudConnectionRepository) {}

  public async queueTechnicalMetricBackfill(
    input: QueueTechnicalBackfillInput,
  ): Promise<TechnicalBackfillResult> {
    const connection = await this.repository.findCloudConnectionForTenant(
      input.tenantId,
      input.cloudConnectionId,
    );
    if (connection === null) {
      throw new FinOpsBaseError('La conexión cloud no existe o no pertenece al tenant activo.', 'NOT_FOUND');
    }

    const lookbackDays = this.resolveLookbackDays(input.lookbackDays);
    const windowHours = this.resolveWindowHours(input.windowHours);
    const rangeEnd = currentMinute();
    const rangeStart = new Date(rangeEnd.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const windows = buildBackfillWindows(rangeStart, rangeEnd, windowHours);
    const existingJobs = [...await this.repository.listIngestionJobsForConnectionRange({
      tenantId: input.tenantId,
      cloudConnectionId: input.cloudConnectionId,
      sourceType: 'TECHNICAL_METRIC',
      targetStart: rangeStart,
      targetEnd: rangeEnd,
    })];

    const createdJobs: IngestionJobSummary[] = [];
    const skippedWindows: TechnicalBackfillWindow[] = [];
    for (const window of windows) {
      if (this.isCovered(existingJobs, window)) {
        skippedWindows.push(window);
        continue;
      }

      const job = await this.repository.createIngestionJob({
        tenantId: input.tenantId,
        cloudConnectionId: input.cloudConnectionId,
        sourceType: 'TECHNICAL_METRIC',
        requestedByUserId: input.userId,
        targetStart: window.targetStart,
        targetEnd: window.targetEnd,
        maxAttempts: 1,
      });
      createdJobs.push(job);
      existingJobs.push(job);
    }

    return {
      cloudConnectionId: input.cloudConnectionId,
      sourceType: 'TECHNICAL_METRIC',
      lookbackDays,
      windowHours,
      rangeStart,
      rangeEnd,
      createdJobs,
      skippedWindows,
    };
  }

  private isCovered(
    jobs: readonly {
      readonly status: string;
      readonly targetStart: Date;
      readonly targetEnd: Date;
    }[],
    window: TechnicalBackfillWindow,
  ): boolean {
    return jobs.some((job) =>
      job.status !== 'FAILED'
      && job.status !== 'CANCELLED'
      && job.targetStart.getTime() <= window.targetStart.getTime()
      && job.targetEnd.getTime() >= window.targetEnd.getTime());
  }

  private resolveLookbackDays(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) return 90;
    const normalized = Math.floor(value);
    if (normalized < 1 || normalized > 90) {
      throw new FinOpsBaseError('El rango histórico debe estar entre 1 y 90 días.', 'VALIDATION_ERROR');
    }
    return normalized;
  }

  private resolveWindowHours(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) return 24;
    const normalized = Math.floor(value);
    if (normalized < 1 || normalized > 24) {
      throw new FinOpsBaseError('La ventana debe estar entre 1 y 24 horas.', 'VALIDATION_ERROR');
    }
    return normalized;
  }
}
