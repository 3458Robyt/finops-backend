import type { CloudIngestionCredential } from '../../domain/interfaces/ICloudIngestionProvider.js';

export function requireString(
  value: unknown,
  fieldName: string,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be configured`);
  }

  return value.trim();
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function getCredential(
  credentials: readonly CloudIngestionCredential[],
  purposes: readonly CloudIngestionCredential['purpose'][],
): CloudIngestionCredential | undefined {
  return credentials.find((credential) => purposes.includes(credential.purpose));
}

export function readObjectArray(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): readonly Record<string, unknown>[] {
  const value = metadata?.[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is Record<string, unknown> => (
    item !== null && typeof item === 'object' && !Array.isArray(item)
  ));
}

export function readStringArray(
  value: unknown,
): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

export function readBoundedPositiveInteger(
  value: unknown,
  defaultValue: number,
  minValue: number,
  maxValue: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return defaultValue;
  }

  return Math.max(minValue, Math.min(maxValue, Math.floor(value)));
}
