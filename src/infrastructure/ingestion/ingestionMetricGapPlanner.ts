import type {
  IngestionScheduleOptions,
  PlannedIngestionJob,
  ScheduleableIngestionConnection,
  ScheduleableIngestionJob,
} from './ingestionJobScheduler.js';

const activeJobStatuses = new Set<string>(['PENDING', 'RUNNING']);
const OCI_RETENTION_DAYS = 90;
const OCI_RETENTION_SAFETY_MARGIN_MS = 6 * 60 * 60 * 1000;

export function resolveTechnicalMetricFloor(
  now: Date,
  providerCode: 'aws' | 'oci',
  catchupDays: number,
): Date {
  const requestedFloorMs = now.getTime() - catchupDays * 24 * 60 * 60 * 1000;
  const providerFloorMs = providerCode === 'oci'
    ? now.getTime() - OCI_RETENTION_DAYS * 24 * 60 * 60 * 1000 + OCI_RETENTION_SAFETY_MARGIN_MS
    : requestedFloorMs;
  return new Date(Math.max(requestedFloorMs, providerFloorMs));
}

/** Builds bounded, newest-first jobs; older uncovered windows follow as capacity frees. */
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
  const floor = alignToWindow(resolveTechnicalMetricFloor(
    now,
    providerCode,
    options.metricCatchupDays ?? OCI_RETENTION_DAYS,
  ), windowMs);
  const covered = new Set((connection.metricCoverageWindowStarts ?? []).map((value) => alignToWindow(value, windowMs).getTime()));
  const coverageWindows = new Map(
    (connection.metricCoverageWindows ?? []).map((window) => [
      alignToWindow(window.windowStart, windowMs).getTime(),
      window.status,
    ]),
  );
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
  // Keep the backlog bounded per connection; a scheduler tick must not queue
  // the entire historical range while a slow provider is still processing it.
  const availableSlots = Math.max(0, maxJobs - activeJobs.length);
  const jobs: PlannedIngestionJob[] = [];

  if (availableSlots === 0) return jobs;

  // Never enqueue a moving, incomplete current window: five-minute scheduler
  // ticks would otherwise create overlapping jobs for the same day.
  const closedThroughMs = alignToWindow(now, windowMs).getTime();
  for (let cursorMs = closedThroughMs - windowMs; cursorMs >= floor.getTime(); cursorMs -= windowMs) {
    const targetStart = new Date(cursorMs);
    const targetEnd = new Date(cursorMs + windowMs);
    const hasSamples = covered.has(cursorMs) || coverageWindows.get(cursorMs) === 'COVERED';
    const hasNoDataEvidence = coverageWindows.get(cursorMs) === 'NO_DATA';
    // A PARTIAL segment is evidence of a gap, not evidence that the window is
    // complete. Only COVERED segments suppress a recovery job.
    const hasSegment = !usingCoverageWindows && segments.some((segment) => segment.sourceType === 'TECHNICAL_METRIC'
      && segment.status === 'COVERED'
      && segment.targetStart.getTime() <= targetStart.getTime()
      && segment.targetEnd.getTime() >= targetEnd.getTime());
    const hasActiveJob = activeJobs.some((job) => job.targetStart !== undefined && overlaps(job.targetStart, job.targetEnd, targetStart, targetEnd));
    // A successful partial read is evidence of the provider's actual response.
    // Replaying the same immutable window every scheduler tick cannot fill a
    // provider-side gap and conflicts with the active+successful idempotency index.
    const hasSuccessfulJob = successfulJobs.some((job) => job.targetStart !== undefined
      && (job.configurationHash === configurationHash || job.configurationHash == null)
      && job.targetStart.getTime() <= targetStart.getTime()
      && job.targetEnd.getTime() >= targetEnd.getTime());
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
      if (jobs.length >= availableSlots) break;
      continue;
    }
    if (hasSamples || hasNoDataEvidence || hasSegment || hasActiveJob || hasSuccessfulJob || hasExplicitNoDataJob) continue;
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
    if (jobs.length >= availableSlots) break;
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
