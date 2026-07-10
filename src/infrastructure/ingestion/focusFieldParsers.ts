/**
 * Helpers puros de parseo de campos primitivos compartidos por los parsers
 * FOCUS del proyecto (dataset de muestra para *seed* y reportes de OCI).
 *
 * Centraliza únicamente los helpers cuya semántica es IDÉNTICA en ambos
 * parsers para evitar duplicación. Las funciones con reglas divergentes
 * (parseo de fechas, etiquetas y proveedor) permanecen en sus módulos de
 * origen para preservar exactamente el comportamiento de cada uno.
 */

/**
 * Normaliza un string: recorta espacios y trata los valores ausentes
 * (`undefined`/`null`), vacíos o el literal `NULL` (sin distinguir mayúsculas)
 * como `null`.
 *
 * @param value - Cadena a normalizar, o `null`/`undefined`.
 * @returns La cadena recortada, o `null` si era ausente, vacía o `NULL`.
 */
export function stringOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed === '' || trimmed.toUpperCase() === 'NULL') {
    return null;
  }

  return trimmed;
}

/**
 * Convierte un string a número en coma flotante, o `null`.
 *
 * Normaliza primero el valor (ausentes/vacíos/`NULL` → `null`) y luego aplica
 * `parseFloat`, devolviendo `null` si el resultado no es finito.
 *
 * @param value - Cadena a convertir, o `null`/`undefined`.
 * @returns El número parseado, o `null` si no es un número válido.
 */
export function numberOrNull(value: string | null | undefined): number | null {
  const normalized = stringOrNull(value);

  if (normalized === null) {
    return null;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
