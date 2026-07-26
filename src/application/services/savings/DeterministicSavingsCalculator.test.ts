import { describe, expect, it } from 'vitest';
import { calculateDeterministicSavings } from './DeterministicSavingsCalculator.js';

const aggregate = (cost: number, coveredDays = 7) => ({
  cost,
  coveredDays,
  sampleCount: coveredDays,
});

describe('calculateDeterministicSavings', () => {
  it('calculates a signed saving and monthly projection without LLM input', () => {
    const result = calculateDeterministicSavings({
      scope: 'RESOURCE',
      windowDays: 7,
      baseline: aggregate(70),
      observation: aggregate(35),
      technicalSampleCount: 14,
      technicalEvidenceRequired: true,
    });

    expect(result.status).toBe('CALCULATED');
    expect(result.observedSavings).toBe(35);
    expect(result.projectedMonthlySavings).toBeCloseTo(152.1875);
    expect(result.technicalValidationStatus).toBe('AVAILABLE');
  });

  it('keeps a cost increase visible and never treats it as verified saving', () => {
    const result = calculateDeterministicSavings({
      scope: 'ACCOUNT',
      windowDays: 7,
      baseline: aggregate(35),
      observation: aggregate(70),
      technicalSampleCount: 0,
      technicalEvidenceRequired: false,
    });

    expect(result.status).toBe('CALCULATED');
    expect(result.projectedMonthlySavings).toBe(0);
    expect(result.costIncreaseMonthlyAmount).toBeCloseTo(152.1875);
    expect(result.reasons).toContain('El costo posterior aumentó; no se puede verificar un ahorro positivo.');
  });

  it('rejects incomplete coverage as insufficient evidence', () => {
    const result = calculateDeterministicSavings({
      scope: 'SERVICE',
      windowDays: 7,
      baseline: aggregate(70, 7),
      observation: aggregate(35, 3),
      technicalSampleCount: 0,
      technicalEvidenceRequired: false,
    });

    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.coverageRatio).toBeCloseTo(3 / 7);
  });

  it('does not verify efficiency when the consumed volume changes materially', () => {
    const result = calculateDeterministicSavings({
      scope: 'RESOURCE',
      windowDays: 7,
      baseline: { ...aggregate(70), quantity: 100, unit: 'OCPU hour' },
      observation: { ...aggregate(35), quantity: 70, unit: 'OCPU hour' },
      technicalSampleCount: 0,
      technicalEvidenceRequired: false,
    });

    expect(result.calculationMethod).toBe('UNIT_NORMALIZED');
    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.quantityChangeRatio).toBeCloseTo(0.3);
  });

  it('blocks verification when technical evidence is missing', () => {
    const result = calculateDeterministicSavings({
      scope: 'RESOURCE',
      windowDays: 7,
      baseline: aggregate(70),
      observation: aggregate(35),
      technicalSampleCount: 0,
      technicalEvidenceRequired: true,
      technicalEvidenceAvailable: false,
    });

    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.technicalValidationStatus).toBe('NOT_AVAILABLE');
  });

  it('blocks verification when the post-execution metrics show saturation', () => {
    const result = calculateDeterministicSavings({
      scope: 'RESOURCE',
      windowDays: 7,
      baseline: aggregate(70),
      observation: aggregate(35),
      technicalSampleCount: 96,
      technicalEvidenceRequired: true,
      technicalEvidenceAvailable: true,
      technicalCriticalSignal: true,
    });

    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.technicalValidationStatus).toBe('CRITICAL_SIGNALS');
  });
});
