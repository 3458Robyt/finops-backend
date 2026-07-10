/**
 * Helpers genéricos de lectura segura de JSON para respuestas de IA.
 *
 * Funciones puras y agnósticas de dominio que transforman valores `unknown`
 * (provenientes de `JSON.parse` sobre texto del modelo) en tipos seguros:
 * type guard de objeto, lectura de cadenas/números y extracción del cuerpo
 * JSON envuelto en cercos Markdown. Se aíslan aquí para reutilizarlas entre
 * los distintos parsers de dominio sin acoplarlas a una entidad concreta.
 *
 * @module application/services/ai/jsonReadHelpers
 */

/**
 * Extrae el cuerpo JSON de una respuesta de IA, tolerando que venga envuelto
 * en un bloque de código Markdown (```json ... ```). Si no hay cerco,
 * devuelve el texto recortado tal cual.
 */
export function extractJson(rawResponse: string): string {
  const trimmed = rawResponse.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fenced?.[1] !== undefined) {
    return fenced[1].trim();
  }

  return trimmed;
}

/** Type guard: comprueba que el valor sea un objeto plano (no nulo ni array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Lee una propiedad como cadena no vacía (recortada); devuelve `undefined` si no aplica. */
export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];

  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  return value.trim();
}

/**
 * Lee una propiedad como número finito. Acepta números directos o cadenas
 * numéricas (parseadas con `parseFloat`); devuelve `undefined` si no es válido.
 */
export function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

/** Filtra un valor desconocido a un arreglo de cadenas no vacías; arreglo vacío si no aplica. */
export function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}
