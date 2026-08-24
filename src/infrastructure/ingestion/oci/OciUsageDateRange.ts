const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * OCI Usage API validates DAILY ranges at UTC day precision. The current
 * partial UTC day is excluded because it is not a complete daily bucket yet.
 */
export function normalizeOciDailyUsageRange(
  requestedStart: Date,
  requestedEnd: Date,
): { readonly start: Date; readonly end: Date } {
  const end = startOfUtcDay(requestedEnd);
  const flooredStart = startOfUtcDay(requestedStart);
  const start = flooredStart < end ? flooredStart : new Date(end.getTime() - DAY_MS);
  return { start, end };
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}
