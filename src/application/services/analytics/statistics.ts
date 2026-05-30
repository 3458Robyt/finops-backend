/**
 * ═══════════════════════════════════════════════════════════════
 * Utilidades estadísticas de analítica de costos
 * ═══════════════════════════════════════════════════════════════
 *
 * Funciones puras de cálculo numérico (media, desviación, variación
 * porcentual y redondeo) usadas por el detector de anomalías, el
 * forecaster y los constructores de tendencias/insights. Se aíslan para
 * poder probarlas de forma independiente y reutilizarlas sin acoplar la
 * lógica estadística a un servicio concreto.
 *
 * @module application/services/analytics/statistics
 */

/** Media aritmética de un arreglo de números; 0 si está vacío. */
export function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Desviación estándar poblacional. Devuelve 0 con menos de 2 valores
 * (no hay dispersión calculable de forma significativa).
 */
export function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }

  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

/**
 * Variación porcentual de `observed` respecto a `baseline`.
 *
 * Casos borde: si la baseline es 0, devuelve 100 cuando hay valor observado
 * positivo (crecimiento desde cero) o 0 si tampoco hay observado, evitando
 * división por cero.
 */
export function percentDelta(baseline: number, observed: number): number {
  if (baseline === 0) {
    return observed > 0 ? 100 : 0;
  }

  return ((observed - baseline) / baseline) * 100;
}

/** Redondea un valor monetario a 2 decimales. */
export function roundCurrency(value: number): number {
  return round(value, 2);
}

/** Redondea `value` al número de decimales indicado por `digits`. */
export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
