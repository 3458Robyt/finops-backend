import { containsSensitiveOutput } from './sensitiveOutputGuard.js';

export function buildNoSensitiveOutputCheck(
  value: unknown,
  artifactLabel: string,
): { readonly name: string; readonly passed: boolean; readonly detail: string } {
  const passed = !containsSensitiveOutput(value);
  return {
    name: 'noSensitiveOutput',
    passed,
    detail: passed
      ? `El ${artifactLabel} no contiene formatos conocidos de secretos o credenciales.`
      : `El ${artifactLabel} contiene un patrón que parece secreto o credencial utilizable.`,
  };
}
