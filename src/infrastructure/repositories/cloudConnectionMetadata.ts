import { Prisma } from '../../generated/prisma/client.js';

export function invalidatedValidationData(metadata: unknown): {
  readonly metadata: Prisma.InputJsonValue;
  readonly lastValidatedAt: null;
} {
  const nextMetadata = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
  delete nextMetadata['capabilityValidation'];
  return {
    metadata: nextMetadata as Prisma.InputJsonValue,
    lastValidatedAt: null,
  };
}
