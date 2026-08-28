/** Returns whether a persisted capability check proved provider identity. */
export function isValidationAuthenticated(validation: Readonly<Record<string, unknown>>): boolean {
  const authentication = validation['authentication'];
  if (isPlainRecord(authentication) && authentication['status'] === 'VERIFIED') return true;

  const capabilities = validation['capabilities'];
  return Array.isArray(capabilities) && capabilities.some((item) => (
    isPlainRecord(item)
    && item['capability'] === 'IDENTITY'
    && item['status'] === 'AVAILABLE'
  ));
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
