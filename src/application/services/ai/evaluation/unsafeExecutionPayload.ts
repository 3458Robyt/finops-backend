/**
 * Detects payloads that could be interpreted as executable tools, SQL, shell
 * or browser code. Human-readable provider instructions remain allowed; this
 * guard only rejects patterns that would turn an LLM artifact into a command
 * or tool invocation.
 */
const unsafeExecutionPatterns = [
  /\btool[_ -]?calls?\b/i,
  /\bfunction[_ -]?calls?\b/i,
  /\b(?:execute|run)[_ -]?(?:sql|command|shell)\b/i,
  /\b(?:drop|truncate)\s+(?:table|schema)\b/i,
  /\b(?:delete|update|insert|select)\s+(?:from|into|table)\b/i,
  /\brm\s+-rf\b/i,
  /\bcurl\b[^\n|]*\|\s*(?:ba)?sh\b/i,
  /<script\b/i,
  /\bpowershell\s+-encodedcommand\b/i,
];

export function containsUnsafeExecutionPayload(value: unknown): boolean {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return true;
  }

  if (serialized === undefined) return true;
  return unsafeExecutionPatterns.some((pattern) => pattern.test(serialized));
}
