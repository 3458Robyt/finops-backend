/**
 * Punto de entrada del parser de reportes FOCUS de OCI (Oracle Cloud
 * Infrastructure).
 *
 * Expone la lectura del reporte desde disco (texto plano o gzip), el parseo del
 * CSV a filas normalizadas y la validación de columnas obligatorias. El mapeo de
 * cada fila reside en `./ociFocusRowMapper.js`, el hashing de identidad en
 * `./ociFocusHash.js`, y los helpers primitivos comunes en `./focusFieldParsers.js`.
 */

import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { parse } from 'csv-parse/sync';
import { toOciFocusRow, type OciFocusReportRow, type RawCsvRow } from './ociFocusRowMapper.js';

export { buildOciCostMetricIdentityHash, buildOciFocusLineHash } from './ociFocusHash.js';
export type { OciFocusReportRow } from './ociFocusRowMapper.js';

/**
 * Resultado del parseo de un CSV FOCUS de OCI.
 */
export interface ParseOciFocusCsvResult {
  /** Lista de columnas detectadas en el CSV. */
  readonly columns: readonly string[];
  /** Número total de registros leídos del CSV (antes de filtrar). */
  readonly rawRowCount: number;
  /** Filas válidas ya normalizadas. */
  readonly rows: readonly OciFocusReportRow[];
  /** Número de registros descartados por no cumplir los campos obligatorios. */
  readonly skippedRowCount: number;
}

/** Columnas mínimas que debe contener un reporte FOCUS de OCI para ser válido. */
const requiredColumns = [
  'BilledCost',
  'BillingCurrency',
  'ChargePeriodEnd',
  'ChargePeriodStart',
  'Provider',
  'ServiceName',
] as const;

/**
 * Lee y parsea un reporte FOCUS de OCI desde el sistema de archivos.
 *
 * Soporta archivos de texto plano (`.csv`) y comprimidos con gzip (`.gz`),
 * que se descomprimen en memoria antes de parsear. El contenido se interpreta
 * siempre como UTF-8.
 *
 * @param filePath - Ruta al archivo del reporte (`.csv` o `.csv.gz`).
 * @returns El resultado del parseo con columnas, filas normalizadas y conteos.
 * @throws {Error} Si faltan columnas obligatorias en el reporte (vía {@link assertRequiredColumns}).
 */
export async function parseOciFocusReportFile(filePath: string): Promise<ParseOciFocusCsvResult> {
  const buffer = await readFile(filePath);
  const text = filePath.toLowerCase().endsWith('.gz')
    ? gunzipSync(buffer).toString('utf8')
    : buffer.toString('utf8');

  return parseOciFocusCsvText(text);
}

/**
 * Parsea el texto de un CSV FOCUS de OCI a filas normalizadas.
 *
 * El CSV se lee con cabecera (`columns: true`), tolerando BOM, número de
 * columnas variable (`relax_column_count`), líneas vacías y espacios. Tras
 * inferir las columnas y validar las obligatorias, cada registro se normaliza;
 * los que no cumplen los campos mínimos se descartan y se contabilizan en
 * `skippedRowCount`.
 *
 * @param csvText - Contenido completo del CSV en texto.
 * @returns El resultado del parseo con columnas, filas válidas y conteos.
 * @throws {Error} Si faltan columnas obligatorias (vía {@link assertRequiredColumns}).
 */
export function parseOciFocusCsvText(csvText: string): ParseOciFocusCsvResult {
  const records = parse(csvText, {
    bom: true,
    columns: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  }) as RawCsvRow[];

  const columns = inferColumns(csvText, records);
  assertRequiredColumns(columns);

  const rows: OciFocusReportRow[] = [];

  for (const raw of records) {
    const row = toOciFocusRow(raw);

    if (row !== null) {
      rows.push(row);
    }
  }

  return {
    columns,
    rawRowCount: records.length,
    rows,
    skippedRowCount: records.length - rows.length,
  };
}

/**
 * Infiere la lista de columnas del CSV.
 *
 * Usa las claves del primer registro parseado si existe; en caso contrario
 * (CSV sin filas de datos) recurre a la primera línea del texto, separando por
 * comas y eliminando el posible BOM (`\uFEFF`) inicial.
 *
 * @param csvText - Texto completo del CSV (para el caso sin registros).
 * @param records - Registros ya parseados.
 * @returns Lista de nombres de columna.
 */
function inferColumns(csvText: string, records: readonly RawCsvRow[]): readonly string[] {
  const firstRecord = records[0];

  if (firstRecord !== undefined) {
    return Object.keys(firstRecord);
  }

  const firstLine = csvText.split(/\r?\n/, 1)[0];
  return firstLine === undefined || firstLine.trim() === ''
    ? []
    : firstLine.split(',').map((column) => column.trim().replace(/^\uFEFF/, ''));
}

/**
 * Verifica que estén presentes todas las columnas obligatorias del reporte.
 *
 * @param columns - Columnas detectadas en el CSV.
 * @throws {Error} Si falta alguna de las columnas de {@link requiredColumns}.
 */
function assertRequiredColumns(columns: readonly string[]): void {
  const columnSet = new Set(columns);
  const missing = requiredColumns.filter((column) => !columnSet.has(column));

  if (missing.length > 0) {
    throw new Error(`OCI FOCUS report is missing required columns: ${missing.join(', ')}`);
  }
}
