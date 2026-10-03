import { Prisma } from '../../generated/prisma/client.js';

/** Counts expected datapoints only in the provider's supported resolution window. */
export function metricCoverageExpectedSamplesSql(now: Date) {
  const timestamp = Prisma.sql`${now.toISOString()}::timestamptz`;
  return Prisma.sql`GREATEST(0, CEIL(EXTRACT(EPOCH FROM (
    CASE WHEN lower(streams."provider_code") = 'aws' THEN
      LEAST(streams.window_end, ${timestamp}, CASE streams.granularity_seconds
        WHEN 60 THEN ${timestamp}
        WHEN 300 THEN ${timestamp} - interval '15 days'
        WHEN 3600 THEN ${timestamp} - interval '63 days'
        ELSE streams.window_start END)
      - GREATEST(streams.window_start, CASE streams.granularity_seconds
        WHEN 60 THEN ${timestamp} - interval '15 days'
        WHEN 300 THEN ${timestamp} - interval '63 days'
        WHEN 3600 THEN ${timestamp} - interval '455 days'
        ELSE streams.window_start END)
    ELSE LEAST(streams.window_end, ${timestamp}) - streams.window_start END
  )) / NULLIF(streams.granularity_seconds, 0)))::int`;
}
