import { createHash } from 'node:crypto';

/** Stable hash shared by provider collectors and coverage persistence. */
export function hashMetricDimensions(dimensions: Readonly<Record<string, string>> | undefined): string {
  const canonical = Object.keys(dimensions ?? {}).sort().map((key) => `${key}=${dimensions?.[key]}`).join('&');
  return createHash('sha256').update(canonical).digest('hex');
}
