/**
 * Punto de entrada del parser del dataset de muestra FOCUS 1.0 usado para
 * poblar datos de ejemplo (*seed*).
 *
 * Expone la URL por defecto, la descarga del CSV y el parseo a filas
 * normalizadas. El mapeo de filas reside en `./focusSampleRowMapper.js`; la
 * construcción de las filas de inserción de Prisma y el hashing, en
 * `./focusSampleSeedBuilder.js`; los helpers primitivos comunes a los parsers
 * FOCUS, en `../ingestion/focusFieldParsers.js`.
 */

import { parse } from 'csv-parse/sync';
import { parseRow, type FocusSampleRow, type RawFocusRow } from './focusSampleRowMapper.js';

export { buildCostMetricSeedRows } from './focusSampleSeedBuilder.js';
export type { FocusSampleRow } from './focusSampleRowMapper.js';

/**
 * URL por defecto del dataset público de muestra FOCUS 1.0 (10 000 filas),
 * publicado por el proyecto FinOps Open Cost and Usage Spec en GitHub.
 * Se usa para poblar datos de ejemplo (*seed*) cuando no se indica otra URL.
 */
export const FOCUS_SAMPLE_URL =
  'https://raw.githubusercontent.com/FinOps-Open-Cost-and-Usage-Spec/FOCUS-Sample-Data/main/FOCUS-1.0/focus_sample_10000.csv';

/**
 * Descarga el CSV de muestra FOCUS desde una URL remota.
 *
 * @param url - URL del dataset a descargar. Por defecto usa la variable de
 *   entorno `FOCUS_SAMPLE_CSV_URL`, o {@link FOCUS_SAMPLE_URL} si no está definida.
 * @returns El contenido del CSV como texto.
 * @throws {Error} Si la respuesta HTTP no es satisfactoria (status fuera del rango 2xx).
 */
export async function downloadFocusSampleCsv(
  url = process.env['FOCUS_SAMPLE_CSV_URL'] ?? FOCUS_SAMPLE_URL,
): Promise<string> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download FOCUS sample data: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

/**
 * Parsea el contenido de un CSV de muestra FOCUS a filas normalizadas.
 *
 * Lee el CSV con cabecera (`columns: true`) omitiendo líneas vacías y sin
 * recortar espacios (`trim: false`). Cada registro se normaliza con
 * {@link parseRow}; las filas que no cumplen los campos obligatorios se descartan.
 *
 * @param csv - Contenido completo del CSV en texto.
 * @returns Lista de filas válidas y normalizadas.
 */
export function parseFocusSampleCsv(csv: string): FocusSampleRow[] {
  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: false,
  }) as RawFocusRow[];

  return records
    .map(parseRow)
    .filter((row): row is FocusSampleRow => row !== null);
}
