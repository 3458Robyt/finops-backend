import { describe, expect, it } from 'vitest';
import { toDomain } from './recommendationMappers.js';

function row(evidence: unknown, amount: number | null) {
  return {
    id: 'rec-1', cloudAccountId: 'account-1', tenantId: 'tenant-1', cloudResourceId: null,
    resourceLinkReason: null, type: 'COST_REVIEW', origin: 'AI_GENERATED', status: 'PENDING',
    severity: 'LOW', title: 'Review', description: 'Review evidence', evidence,
    estimatedMonthlySavings: amount, currency: 'COP', createdAt: new Date('2026-09-17T00:00:00Z'),
    updatedAt: new Date('2026-09-17T00:00:00Z'),
  } as unknown as Parameters<typeof toDomain>[0];
}

describe('recommendation mapper savings exposure', () => {
  it('hides legacy root/evidence amounts while retaining an explicit audit status', () => {
    const result = toDomain(row({ potentialMonthlySavings: 12, maxEstimatedMonthlySavings: 12 }, 12));
    expect(result.estimatedMonthlySavings).toBeUndefined();
    expect(result.evidence).toMatchObject({ savingsStatus: 'UNVERIFIED_LEGACY' });
    expect(result.evidence).not.toHaveProperty('potentialMonthlySavings');
  });

  it('exposes a savings amount only when deterministic price evidence reconciles', () => {
    const calculation = {
      provenance: 'SERVER_DETERMINISTIC', version: 'priced-alternative/v1', status: 'CALCULATED',
      formula: 'BASELINE_MINUS_ALTERNATIVE_MONTHLY', baselineMonthlyCost: 100,
      alternativeMonthlyCost: 88, amount: 12, currency: 'COP', priceEvidenceRef: 'oci-price:sku-a-to-b',
    };
    const result = toDomain(row({ savingsCalculation: calculation }, 12));
    expect(result.estimatedMonthlySavings).toBe(12);
  });
});
