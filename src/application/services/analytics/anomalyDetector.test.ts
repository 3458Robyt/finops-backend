import { describe, expect, it } from 'vitest';
import type { MonthlyCostPoint } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import { detectAnomalies, scoreAnomalySeverity, type AnomalyThresholds } from './anomalyDetector.js';

/**
 * Suite del detector de anomalias de costo.
 *
 * Valida la heuristica estadistica de forma aislada:
 * - Deteccion por z-score aun con incremento porcentual bajo.
 * - Filtro de delta absoluto minimo (minAbsoluteDelta).
 * - Los cuatro niveles de severidad (LOW/MEDIUM/HIGH/CRITICAL).
 *
 * Nota: a diferencia del mock de CostAnalyticsService.test.ts (puntos
 * 10/12/14, deltaAmount=3) que no dispara nada con umbrales de produccion,
 * aqui los datos SI superan los umbrales configurados en la suite.
 */

/** Umbrales de prueba; estables y faciles de razonar en los calculos. */
const thresholds: AnomalyThresholds = {
  minAbsoluteDelta: 50,
  mediumDeltaPercent: 20,
  highDeltaPercent: 50,
  criticalDeltaPercent: 100,
};

/** Construye un punto mensual de costo del mismo grupo (service:COMPUTE). */
function point(month: string, cost: number): MonthlyCostPoint {
  return {
    cost,
    currency: 'USD',
    groupBy: 'service',
    groupKey: 'COMPUTE',
    metricCount: 1,
    month,
    provider: 'OCI',
    serviceName: 'COMPUTE',
  };
}

describe('detectAnomalies', () => {
  it('detecta una anomalia por z-score aunque el incremento porcentual sea bajo', () => {
    // Baseline ~1000 con dispersion pequena (stddev ~5.77); el mes actual
    // (1060) solo crece 6% pero su z-score (~10.39) es muy alto.
    const series: MonthlyCostPoint[] = [
      point('2026-01', 990),
      point('2026-02', 1010),
      point('2026-03', 1000),
      point('2026-04', 1000),
      point('2026-05', 1000),
      point('2026-06', 1000),
      point('2026-07', 1060),
    ];

    const anomalies = detectAnomalies('tenant-oci', series, thresholds);

    expect(anomalies).toHaveLength(1);
    const anomaly = anomalies[0]!;
    // baseline = media de los 6 meses previos = 6000 / 6 = 1000.
    expect(anomaly.baselineCost).toBe(1000);
    expect(anomaly.observedCost).toBe(1060);
    expect(anomaly.deltaAmount).toBe(60);
    // deltaPercent = 60 / 1000 * 100 = 6% (por debajo de mediumDeltaPercent).
    expect(anomaly.deltaPercent).toBe(6);
    // z-score = 60 / sqrt(200/6) ~= 10.3923, redondeado a 4 decimales.
    expect(anomaly.zScore).toBe(10.3923);
    expect(anomaly.tenantId).toBe('tenant-oci');
    expect(anomaly.status).toBe('OPEN');
    // Con z-score definido, el metodo registrado es 'z-score + delta'.
    expect((anomaly.evidence as { method: string }).method).toBe('z-score + delta');
    // Severidad gobernada por el z-score (>= 3) => CRITICAL.
    expect(anomaly.severity).toBe('CRITICAL');
  });

  it('aplica el umbral minDelta: descarta cuando el delta absoluto es menor que minAbsoluteDelta', () => {
    // baseline = 11, current = 14 => deltaAmount = 3, deltaPercent ~27.3%, z=3.
    // Aunque el porcentaje y el z-score calificarian, 3 < 50 => se descarta.
    const series: MonthlyCostPoint[] = [
      point('2026-02', 10),
      point('2026-03', 12),
      point('2026-04', 14),
    ];

    const filtered = detectAnomalies('tenant-oci', series, thresholds);
    expect(filtered).toHaveLength(0);

    // Con un minAbsoluteDelta permisivo, el mismo dato SI dispara la anomalia.
    const permissive: AnomalyThresholds = { ...thresholds, minAbsoluteDelta: 1 };
    const detected = detectAnomalies('tenant-oci', series, permissive);
    expect(detected).toHaveLength(1);
    expect(detected[0]!.deltaAmount).toBe(3);
  });
});

describe('scoreAnomalySeverity', () => {
  it('asigna LOW cuando ni el porcentaje ni el z-score alcanzan el umbral MEDIUM', () => {
    expect(scoreAnomalySeverity(10, 0.5, thresholds)).toBe('LOW');
    // Sin z-score y porcentaje por debajo de mediumDeltaPercent => LOW.
    expect(scoreAnomalySeverity(15, undefined, thresholds)).toBe('LOW');
  });

  it('asigna MEDIUM por porcentaje (>= mediumDeltaPercent) o por z-score (>= 1.5)', () => {
    expect(scoreAnomalySeverity(25, undefined, thresholds)).toBe('MEDIUM');
    expect(scoreAnomalySeverity(5, 1.6, thresholds)).toBe('MEDIUM');
  });

  it('asigna HIGH por porcentaje (>= highDeltaPercent) o por z-score (>= 2)', () => {
    expect(scoreAnomalySeverity(60, undefined, thresholds)).toBe('HIGH');
    expect(scoreAnomalySeverity(10, 2.5, thresholds)).toBe('HIGH');
  });

  it('asigna CRITICAL por porcentaje (>= criticalDeltaPercent) o por z-score (>= 3)', () => {
    expect(scoreAnomalySeverity(150, undefined, thresholds)).toBe('CRITICAL');
    expect(scoreAnomalySeverity(5, 3, thresholds)).toBe('CRITICAL');
  });
});
