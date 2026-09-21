import type { CloudIngestionJobContext } from '../../../domain/interfaces/ICloudIngestionProvider.js';

const OCI_RETENTION_SAFETY_MARGIN_MS = 6 * 60 * 60 * 1000;

/** OCI rejects a request as soon as its start crosses the rolling 90-day limit. */
export function resolveOciRequestRange(job: Pick<CloudIngestionJobContext, 'targetStart' | 'targetEnd'>, now = new Date()): {
  readonly startTime: Date;
  readonly endTime: Date;
} {
  const retentionMs = 90 * 24 * 60 * 60 * 1000;
  const earliestAllowed = new Date(now.getTime() - retentionMs + OCI_RETENTION_SAFETY_MARGIN_MS);
  const startTime = job.targetStart > earliestAllowed ? job.targetStart : earliestAllowed;
  const endTime = job.targetEnd < now ? job.targetEnd : now;
  if (endTime <= startTime) throw new Error('OCI metric job is outside the provider 90-day retention window.');
  return { startTime, endTime };
}
