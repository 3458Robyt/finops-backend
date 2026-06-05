import { describe, expect, it } from 'vitest';
import { average, standardDeviation } from './statistics.js';

/**
 * Z-score derivado de las funciones públicas (statistics.ts no exporta zScore):
 * z = (valor − media) / desviación estándar.
 */
function zScore(value: number, values: readonly number[]): number {
  const stdDev = standardDeviation(values);
  if (stdDev === 0) {
    return 0;
  }
  return (value - average(values)) / stdDev;
}

describe('statistics: average', () => {
  it('calcula la media aritmética con valores conocidos', () => {
    // (2 + 4 + 6 + 8) / 4 = 20 / 4 = 5
    expect(average([2, 4, 6, 8])).toBe(5);
  });

  it('devuelve 0 para un arreglo vacío', () => {
    expect(average([])).toBe(0);
  });

  it('devuelve el único valor cuando hay un solo elemento', () => {
    expect(average([42])).toBe(42);
  });
});

describe('statistics: standardDeviation (poblacional)', () => {
  it('calcula la desviación estándar poblacional con un set clásico', () => {
    // [2,4,4,4,5,5,7,9] → media = 40/8 = 5
    // desviaciones²: 9,1,1,1,0,0,4,16 → suma = 32 → varianza = 32/8 = 4 → √4 = 2
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
  });

  it('calcula la desviación con raíz no entera (varianza = 5)', () => {
    // [2,4,6,8] → media = 5 → desviaciones²: 9,1,1,9 → suma = 20
    // varianza = 20/4 = 5 → √5 ≈ 2.2360679...
    expect(standardDeviation([2, 4, 6, 8])).toBeCloseTo(Math.sqrt(5), 10);
  });

  it('devuelve 0 con menos de 2 valores', () => {
    expect(standardDeviation([])).toBe(0);
    expect(standardDeviation([5])).toBe(0);
  });
});

describe('statistics: z-score (derivado de average y standardDeviation)', () => {
  // Set base: [2,4,4,4,5,5,7,9] con media = 5 y desviación = 2.
  const values = [2, 4, 4, 4, 5, 5, 7, 9];

  it('z-score positivo: (9 − 5) / 2 = 2', () => {
    expect(zScore(9, values)).toBe(2);
  });

  it('z-score cero cuando el valor coincide con la media: (5 − 5) / 2 = 0', () => {
    expect(zScore(5, values)).toBe(0);
  });

  it('z-score negativo: (2 − 5) / 2 = -1.5', () => {
    expect(zScore(2, values)).toBe(-1.5);
  });

  it('z-score = 0 cuando la desviación es 0 (evita división por cero)', () => {
    expect(zScore(10, [7])).toBe(0);
  });
});
