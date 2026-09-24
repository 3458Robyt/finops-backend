import { createHash } from 'node:crypto';

/** Must match the metric-sample dimensions hash used by OCI ingestion and coverage. */
export function hashOciMetricDimensions(dimensions: Readonly<Record<string, string>> | undefined): string {
  const values = dimensions ?? {};
  const canonical = Object.keys(values).sort().map((key) => `${key}=${values[key]}`).join('&');
  return createHash('sha256').update(canonical).digest('hex');
}
