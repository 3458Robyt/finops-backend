import type {
  IngestionScheduleOptions,
  PlannedIngestionJob,
  ScheduleableIngestionConnection,
  ScheduleableIngestionJob,
} from './ingestionJobScheduler.js';

const activeJobStatuses = new Set<string>(['PENDING', 'RUNNING']);

/** Builds bounded, oldest-first technical backfill jobs for uncovered windows. */
export function buildMissingTechnicalMetricJobs(
  connection: ScheduleableIngestionConnection,
  providerCode: 'aws' | 'oci',
  options: IngestionScheduleOptions,
  configurationHash: string,
  requestContext: Readonly<Record<string, unknown>> | undefined,
): readonly PlannedIngestionJob[] {
  const now = options.now;
  const windowMs = Math.max(
    30 * 60 * 1000,
    (options.metricCatchupWindowMinutes ?? 24 * 60) * 60 * 1000,
  );
  const floor = alignToWindow(new Date(now.getTime() - (options.metricCatchupDays ?? 90) * 24 * 60 * 60 * 1000), windowMs);
  const covered = new Set((connection.metricCoverageWindowStarts ?? []).map((value) => alignToWindow(value, windowMs).getTime()));
  const usingCoverageWindows = connection.metricCoverageWindowStarts !== undefined;
  const segments = connection.ingestionCoverageSegments ?? [];
  const activeJobs = connection.ingestionJobs.filter((job) => job.sourceType === 'TECHNICAL_METRIC' && activeJobStatuses.has(job.status));
  const successfulJobs = connection.ingestionJobs.filter((job) => (
    job.sourceType === 'TECHNICAL_METRIC'
    && job.status === 'SUCCESS'
    && hasSuccessfulDataEvidence(job)
  ));
  const failedJobs = connection.ingestionJobs.filter((job) => (
    job.sourceType === 'TECHNICAL_METRIC' && job.status === 'FAILED'
  ));
  const maxJobs = options.maxMetricBackfillJobsPerConnection ?? 48;
  const jobs: PlannedIngestionJob[] = [];

  for (let cursorMs = floor.getTime(); cursorMs < now.getTime(); cursorMs += windowMs) {
    const targetStart = new Date(cursorMs);
    const targetEnd = new Date(Math.min(cursorMs + windowMs, now.getTime()));
    const hasSamples = covered.has(cursorMs);
    const hasSegment = !usingCoverageWindows && segments.some((segment) => segment.sourceType === 'TECHNICAL_METRIC'
      && (segment.status === 'COVERED' || segment.status === 'PARTIAL')
      && segment.targetStart.getTime() <= targetStart.getTime()
      && segment.targetEnd.getTime() >= targetEnd.getTime());
    const hasActiveJob = activeJobs.some((job) => job.targetStart !== undefined && overlaps(job.targetStart, job.targetEnd, targetStart, targetEnd));
    const hasSuccessfulJob = !usingCoverageWindows && successfulJobs.some((job) => job.targetStart !== undefined && overlaps(job.targetStart, job.targetEnd, targetStart, targetEnd));
    const hasExplicitNoDataJob = successfulJobs.some((job) => (
      job.dataOutcome === 'NO_DATA'
      && job.targetStart !== undefined
      && overlaps(job.targetStart, job.targetEnd, targetStart, targetEnd)
    ));
    const hasStaleFailedJob = failedJobs.some((job) => (
      job.targetStart !== undefined
      && overlaps(job.targetStart, job.targetEnd, targetStart, targetEnd)
      && (job.configurationHash ?? '') !== configurationHash
    ));
    if (hasStaleFailedJob && !hasActiveJob && !hasSuccessfulJob) {
      jobs.push({
        tenantId: connection.tenantId,
        cloudConnectionId: connection.id,
        providerCode,
        sourceType: 'TECHNICAL_METRIC',
        targetStart,
        targetEnd,
        maxAttempts: options.maxAttempts,
        configurationHash,
        ...(requestContext === undefined ? {} : { requestContext }),
        reason: `Se reintenta una ventana técnica fallida con configuración anterior entre ${targetStart.toISOString()} y ${targetEnd.toISOString()}.`,
      });
      if (jobs.length >= maxJobs) break;
      continue;
    }
    if (hasSamples || hasSegment || hasActiveJob || hasSuccessfulJob || hasExplicitNoDataJob) continue;
    jobs.push({
      tenantId: connection.tenantId,
      cloudConnectionId: connection.id,
      providerCode,
      sourceType: 'TECHNICAL_METRIC',
      targetStart,
      targetEnd,
      maxAttempts: options.maxAttempts,
      configurationHash,
      ...(requestContext === undefined ? {} : { requestContext }),
      reason: `Se recupera ventana técnica sin evidencia entre ${targetStart.toISOString()} y ${targetEnd.toISOString()}.`,
    });
    if (jobs.length >= maxJobs) break;
  }
  return jobs;
}

function hasSuccessfulDataEvidence(job: ScheduleableIngestionJob): boolean {
  if (job.dataOutcome === 'NO_DATA') return true;
  if (job.dataOutcome !== undefined && job.dataOutcome !== null && job.dataOutcome !== 'DATA_WRITTEN') return false;
  if (!isRecord(job.resultSummary)) return false;
  const coverage = job.resultSummary['coverage'];
  if (isRecord(coverage) && Number(coverage['samples'] ?? coverage['samplesWritten'] ?? 0) > 0) return true;
  return Number(job.resultSummary['samples'] ?? job.resultSummary['samplesWritten'] ?? 0) > 0;
}

function overlaps(leftStart: Date, leftEnd: Date, rightStart: Date, rightEnd: Date): boolean {
  return leftStart.getTime() < rightEnd.getTime() && leftEnd.getTime() > rightStart.getTime();
}

function alignToWindow(value: Date, windowMs: number): Date {
  return new Date(Math.floor(value.getTime() / windowMs) * windowMs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
