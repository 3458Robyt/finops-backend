/**
 * Detecta secretos o credenciales accidentales en artefactos generados.
 * Las frases generales sobre seguridad son válidas; solo se bloquean formatos
 * que parecen credenciales utilizables o URLs de conexión autenticadas.
 */
const sensitiveOutputPatterns = [
  /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/i,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/,
  /\b(?:sk|nvapi)-[a-zA-Z0-9_-]{16,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/i,
  /\b(?:password|passwd|api[_-]?key|secret|private[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/i,
];

export function containsSensitiveOutput(value: unknown): boolean {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return true;
  }
  if (serialized === undefined) return true;
  return sensitiveOutputPatterns.some((pattern) => pattern.test(serialized));
}
