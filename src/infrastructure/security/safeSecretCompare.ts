import { timingSafeEqual } from 'node:crypto';

/** Compara secretos sin revelar diferencias de longitud o contenido por tiempo. */
export function safeSecretEqual(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  if (expectedBytes.length !== providedBytes.length) return false;
  return timingSafeEqual(expectedBytes, providedBytes);
}
