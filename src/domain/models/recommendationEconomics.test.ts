import { describe, expect, it } from 'vitest';
import {
  hasPotentialSavings,
  isVerifiedSavingsCalculation,
  sanitizeSavingsEvidence,
} from './recommendationEconomics.js';

const validEvidence = {
  savingsCalculation: {
    provenance: 'SERVER_DETERMINISTIC',
    version: 'priced-alternative/v1',
    status: 'CALCULATED',
    formula: 'BASELINE_MINUS_ALTERNATIVE_MONTHLY',
    baselineMonthlyCost: 100,
    alternativeMonthlyCost: 88,
    amount: 12,
    currency: 'COP',
    priceEvidenceRef: 'oci-price:compute:shape-a-to-b',
  },
};

describe('recommendation savings evidence', () => {
  it('accepts an amount only when a server price comparison reconciles exactly', () => {
    expect(isVerifiedSavingsCalculation(validEvidence, 12, 'COP')).toBe(true);
    expect(hasPotentialSavings({ status: 'PENDING', estimatedMonthlySavings: 12, currency: 'COP', evidence: validEvidence })).toBe(true);
  });

  it('rejects legacy percentage estimates without a deterministic priced alternative', () => {
    const legacy = { normalizedMonthlyCost: 100, maxEstimatedMonthlySavings: 12, sourceFacts: ['Cost and usage observed'] };
    expect(isVerifiedSavingsCalculation(legacy, 12, 'COP')).toBe(false);
    expect(hasPotentialSavings({ status: 'PENDING', estimatedMonthlySavings: 12, currency: 'COP', evidence: legacy })).toBe(false);
    expect(sanitizeSavingsEvidence({ ...legacy, potentialMonthlySavings: 12 }, 12, 'COP')).toMatchObject({
      savingsStatus: 'UNVERIFIED_LEGACY',
    });
    expect(sanitizeSavingsEvidence({ ...legacy, potentialMonthlySavings: 12 }, 12, 'COP')).not.toHaveProperty('potentialMonthlySavings');
  });

  it('rejects mismatched currency, amount, formula, or non-saving comparisons', () => {
    expect(isVerifiedSavingsCalculation(validEvidence, 12, 'USD')).toBe(false);
    expect(isVerifiedSavingsCalculation(validEvidence, 11.5, 'COP')).toBe(false);
    expect(isVerifiedSavingsCalculation({ savingsCalculation: { ...validEvidence.savingsCalculation, alternativeMonthlyCost: 101 } }, 12, 'COP')).toBe(false);
  });
});
