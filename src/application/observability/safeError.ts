const DEFAULT_MAX_LENGTH = 300;

/**
 * Convierte errores externos en un mensaje acotado y sin credenciales para
 * logs. SDKs y clientes HTTP pueden incluir URLs, cabeceras o cadenas de
 * conexión en sus mensajes.
 */
export function safeErrorMessage(error: unknown, maxLength = DEFAULT_MAX_LENGTH): string {
  const raw = error instanceof Error ? error.message : stringifyUnknownError(error);
  const normalizedLimit = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : DEFAULT_MAX_LENGTH;
  const sanitized = raw
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, '[REDACTED_PEM]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi, '$1:[REDACTED]@')
    .replace(/\b((?:authorization|proxy-authorization)\s*[:=])\s*(?:bearer\s+)?[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(/\bbearer\s+[a-zA-Z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/\b((?:cookie|set-cookie)\s*[:=])[^\r\n]*/gi, '$1 [REDACTED]')
    .replace(/((?:api[-_]?key|access[-_]?key|secret|password|passwd|token|private[-_]?key|client[-_]?secret|database[-_]?url|connection[-_]?string)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|nvapi)-[a-zA-Z0-9_-]{16,}/g, '[REDACTED_API_KEY]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\s+/g, ' ')
    .trim();

  return (sanitized === '' ? 'Unknown error' : sanitized).slice(0, normalizedLimit);
}

function stringifyUnknownError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error === null || error === undefined) return String(error);
  if (typeof error !== 'object') return String(error);

  try {
    const serialized = JSON.stringify(error, (key, value: unknown) => {
      if (/authorization|cookie|secret|password|token|private.?key|api.?key|credential/i.test(key)) {
        return '[REDACTED]';
      }
      return value;
    });
    return serialized === undefined ? String(error) : serialized;
  } catch {
    return String(error);
  }
}

export function safeErrorName(error: unknown): string {
  return error instanceof Error && error.name.trim() !== '' ? error.name : 'UnknownError';
}
