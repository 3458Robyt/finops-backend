export const DEFAULT_INGESTION_VALIDATION_MAX_AGE_MINUTES = 24 * 60;

export function isIngestionValidationFresh(
  lastValidatedAt: Date | null | undefined,
  now: Date,
  maxAgeMinutes = DEFAULT_INGESTION_VALIDATION_MAX_AGE_MINUTES,
): boolean {
  if (lastValidatedAt === null || lastValidatedAt === undefined) return false;
  const validationAgeMs = now.getTime() - lastValidatedAt.getTime();
  return Number.isFinite(validationAgeMs)
    && Number.isFinite(maxAgeMinutes)
    && maxAgeMinutes > 0
    && validationAgeMs >= 0
    && validationAgeMs <= maxAgeMinutes * 60_000;
}
