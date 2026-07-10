import { describe, expect, it } from 'vitest';
import type { MonthlyCostPoint } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import { generateForecasts } from './costForecaster.js';

/**
 * Forma de la evidencia que adjunta el forecaster (tipada como `unknown` en el
 * input de persistencia). Se declara aqui solo para poder aseverar sus campos.
 */
interface ForecastEvidence {
  readonly sourceMonths: readonly string[];
  readonly weightedAverage: number;
  readonly monthlyTrend: number;
}

const FEB = '2026-02-01T00:00:00.000Z';
const MAR = '2026-03-01T00:00:00.000Z';
const APR = '2026-04-01T00:00:00.000Z';
const JAN = '2026-01-01T00:00:00.000Z';

/** Construye un punto de costo mensual para el grupo COMPUTE/service. */
function point(month: string, cost: number, groupKey = 'COMPUTE'): MonthlyCostPoint {
  return {
    cost,
    currency: 'USD',
    groupBy: 'service',
    groupKey,
    metricCount: 1,
    month,
    provider: 'OCI',
    serviceName: groupKey,
  };
}

describe('generateForecasts', () => {
  it('aplica media movil ponderada y tendencia lineal sobre datos conocidos', () => {
    // costos [100, 200, 300]:
    //   weightedAverage = 100*0.2 + 200*0.3 + 300*0.5 = 230
    //   trend = 300 - 100 = 200 -> monthlyTrend = 200 / 2 = 100
    //   predicted(+1..+3) = 230 + 100*offset = 330, 430, 530
    //   std([100,200,300]) ~= 81.65 -> confidence = round(1 - 81.65/230, 4) = 0.645
    const forecasts = generateForecasts('tenant-1', [
      point(FEB, 100),
      point(MAR, 200),
      point(APR, 300),
    ]);

    expect(forecasts).toHaveLength(3);

    const predicted = forecasts.map((forecast) => forecast.predictedCost);
    expect(predicted).toEqual([330, 430, 530]);

    for (const forecast of forecasts) {
      expect(forecast.confidence).toBe(0.645);
      expect(forecast.method).toBe('weighted-moving-average-linear-trend');
      expect(forecast.currency).toBe('USD');
      expect(forecast.groupBy).toBe('service');
      expect(forecast.groupKey).toBe('COMPUTE');
      expect(forecast.provider).toBe('OCI');
      expect(forecast.serviceName).toBe('COMPUTE');
      expect(forecast.lowerBound).toBeGreaterThanOrEqual(0);
      expect(forecast.lowerBound).toBeLessThanOrEqual(forecast.predictedCost);
      expect(forecast.upperBound).toBeGreaterThanOrEqual(forecast.predictedCost);

      const evidence = forecast.evidence as ForecastEvidence;
      expect(evidence.weightedAverage).toBe(230);
      expect(evidence.monthlyTrend).toBe(100);
      expect(evidence.sourceMonths).toEqual([FEB, MAR, APR]);
    }
  });

  it('proyecta los meses +1, +2 y +3 en UTC a partir del ultimo mes', () => {
    const forecasts = generateForecasts('tenant-1', [
      point(FEB, 100),
      point(MAR, 200),
      point(APR, 300),
    ]);

    const months = forecasts.map((forecast) => forecast.forecastMonth.toISOString());
    expect(months).toEqual([
      '2026-05-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    ]);
  });

  it('ordena por mes y usa solo los ultimos tres puntos', () => {
    // Entrada desordenada y con un cuarto punto antiguo (JAN=999) que debe
    // ignorarse: los ultimos tres por mes siguen siendo [100, 200, 300].
    const forecasts = generateForecasts('tenant-1', [
      point(MAR, 200),
      point(JAN, 999),
      point(APR, 300),
      point(FEB, 100),
    ]);

    expect(forecasts).toHaveLength(3);
    expect(forecasts.map((forecast) => forecast.predictedCost)).toEqual([330, 430, 530]);

    const evidence = forecasts[0]?.evidence as ForecastEvidence;
    expect(evidence.sourceMonths).toEqual([FEB, MAR, APR]);
    expect(evidence.weightedAverage).toBe(230);
    expect(evidence.monthlyTrend).toBe(100);
  });

  it('devuelve vacio cuando el grupo tiene menos de 3 puntos', () => {
    expect(generateForecasts('tenant-1', [])).toEqual([]);
    expect(generateForecasts('tenant-1', [point(APR, 300)])).toEqual([]);
    expect(generateForecasts('tenant-1', [point(MAR, 200), point(APR, 300)])).toEqual([]);
  });

  it('fija la confianza en 0.9 cuando no hay dispersion (serie plana)', () => {
    // costos [50, 50, 50]: std = 0 -> confidence cruda = 1, acotada a 0.9.
    //   weightedAverage = 50, monthlyTrend = 0 -> predicted = 50
    //   spread = max(0, 50*(1-0.9)) = 5 -> [45, 55]
    const forecasts = generateForecasts('tenant-1', [
      point(FEB, 50),
      point(MAR, 50),
      point(APR, 50),
    ]);

    expect(forecasts).toHaveLength(3);
    for (const forecast of forecasts) {
      expect(forecast.confidence).toBe(0.9);
      expect(forecast.predictedCost).toBe(50);
      expect(forecast.lowerBound).toBe(45);
      expect(forecast.upperBound).toBe(55);
    }
  });

  it('fija la confianza en 0.45 cuando la dispersion es muy alta', () => {
    // costos [10, 10, 1000]: std/weightedAverage da confianza cruda ~0.076,
    // acotada al minimo 0.45.
    const forecasts = generateForecasts('tenant-1', [
      point(FEB, 10),
      point(MAR, 10),
      point(APR, 1000),
    ]);

    expect(forecasts).toHaveLength(3);
    for (const forecast of forecasts) {
      expect(forecast.confidence).toBe(0.45);
    }
  });

  it('nunca proyecta costos negativos (piso en 0) con tendencia descendente', () => {
    // costos [300, 200, 50]:
    //   weightedAverage = 300*0.2 + 200*0.3 + 50*0.5 = 145
    //   monthlyTrend = (50 - 300) / 2 = -125
    //   predicted(+1) = max(0, 145 - 125) = 20
    //   predicted(+2) = max(0, 145 - 250) = 0
    //   predicted(+3) = max(0, 145 - 375) = 0
    const forecasts = generateForecasts('tenant-1', [
      point(FEB, 300),
      point(MAR, 200),
      point(APR, 50),
    ]);

    expect(forecasts.map((forecast) => forecast.predictedCost)).toEqual([20, 0, 0]);
    for (const forecast of forecasts) {
      expect(forecast.lowerBound).toBeGreaterThanOrEqual(0);
    }
  });

  it('agrupa por groupKey y genera 3 forecasts por grupo', () => {
    const forecasts = generateForecasts('tenant-1', [
      point(FEB, 100, 'COMPUTE'),
      point(MAR, 200, 'COMPUTE'),
      point(APR, 300, 'COMPUTE'),
      point(FEB, 50, 'STORAGE'),
      point(MAR, 50, 'STORAGE'),
      point(APR, 50, 'STORAGE'),
    ]);

    expect(forecasts).toHaveLength(6);
    expect(forecasts.filter((forecast) => forecast.groupKey === 'COMPUTE')).toHaveLength(3);
    expect(forecasts.filter((forecast) => forecast.groupKey === 'STORAGE')).toHaveLength(3);
  });
});
