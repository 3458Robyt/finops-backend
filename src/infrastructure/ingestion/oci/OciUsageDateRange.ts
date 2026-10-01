const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * OCI Usage API accepts DAILY ranges at UTC day precision. Historical partial
 * job windows include their full requested UTC day; the current partial day is
 * excluded until the provider has a complete daily bucket.
 */
export function normalizeOciDailyUsageRange(
  requestedStart: Date,
  requestedEnd: Date,
  now = new Date(),
): { readonly start: Date; readonly end: Date } {
  const today = startOfUtcDay(now);
  const requestedEndDay = startOfUtcDay(requestedEnd);
  let end = requestedEndDay;
  if (requestedEndDay < today && requestedEnd.getTime() > requestedEndDay.getTime()) {
    end = new Date(requestedEndDay.getTime() + DAY_MS);
  }
  if (end > today) end = today;

  const flooredStart = startOfUtcDay(requestedStart);
  const start = flooredStart < end ? flooredStart : new Date(end.getTime() - DAY_MS);
  return { start, end };
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}
