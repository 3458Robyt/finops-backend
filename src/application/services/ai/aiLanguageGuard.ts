const spanishSignals = new Set([
  'ahorro',
  'analizar',
  'costo',
  'consumo',
  'datos',
  'evidencia',
  'ejecución',
  'ejecutar',
  'instancia',
  'métrica',
  'oportunidad',
  'optimizar',
  'para',
  'recurso',
  'revisar',
  'técnica',
  'validar',
]);

/**
 * Heurística mínima y determinista para impedir que el proveedor devuelva un
 * artefacto completamente anglófono cuando el contrato del producto exige
 * español. No pretende sustituir un detector lingüístico general: solo actúa
 * como compuerta de seguridad sobre texto generado.
 */
export function looksLikeSpanish(text: string): boolean {
  const normalized = text.toLocaleLowerCase('es-ES');
  if (/[áéíóúñü]/u.test(normalized)) {
    return true;
  }

  const words = new Set(normalized.match(/[a-záéíóúñü]+/giu) ?? []);
  return [...spanishSignals].some((signal) => words.has(signal));
}

export function collectText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(collectText).join(' ');
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).map(collectText).join(' ');
  }
  return '';
}
