import { describe, expect, it } from 'vitest';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import { parseAuditReport, parseExecutionPlan, parseRecommendationDrafts } from './finOpsAiResponseParser.js';

describe('finOpsAiResponseParser', () => {
  it('accepts an explicit empty recommendations array as a safe abstention', () => {
    const snapshot = {
      currency: 'USD',
      accounts: [{ cloudAccountId: 'account-1' }],
    } as CostAnalyticsSnapshot;

    expect(parseRecommendationDrafts('{"recommendations":[]}', snapshot)).toEqual([]);
  });

  it.each([
    '{}',
    '{"recommendations":null}',
    '{"recommendations":[{"cloudAccountId":"other","type":"x"}]}',
  ])('rejects malformed or invalid recommendation payloads instead of treating them as abstention: %s', (raw) => {
    const snapshot = {
      currency: 'USD',
      accounts: [{ cloudAccountId: 'account-1' }],
    } as CostAnalyticsSnapshot;

    expect(() => parseRecommendationDrafts(raw, snapshot))
      .toThrow('AI did not return valid recommendations');
  });

  it('keeps structured repair metadata from the AI auditor', () => {
    const report = parseAuditReport(
      JSON.stringify({
        verdict: 'NEEDS_REVISION',
        score: 72,
        checks: [{ name: 'evidence', passed: false, notes: 'Falta candidateId.' }],
        blockingIssues: ['La recomendacion no cita candidateId.'],
        requiredChanges: ['Agregar candidateId.'],
        recommendationIndexes: [0, 2],
        repairInstructions: ['Usa el candidato resource-1 y reduce el ahorro estimado.'],
      }),
    );

    expect(report.verdict).toBe('NEEDS_REVISION');
    expect(report.recommendationIndexes).toEqual([0, 2]);
    expect(report.repairInstructions).toEqual([
      'Usa el candidato resource-1 y reduce el ahorro estimado.',
    ]);
  });

  it('parses the audit result for each recommendation in a batch', () => {
    const report = parseAuditReport(JSON.stringify({
      verdict: 'REJECTED',
      score: 84,
      checks: [],
      blockingIssues: [],
      requiredChanges: [],
      candidateAudits: [
        { index: 0, candidateId: 'service-1', verdict: 'APPROVED', score: 91, checks: [], blockingIssues: [], requiredChanges: [] },
        { index: 1, candidateId: 'service-2', verdict: 'REJECTED', score: 42, checks: [], blockingIssues: ['Ahorro no sustentado'], requiredChanges: [] },
      ],
    }));

    expect(report.candidateAudits).toHaveLength(2);
    expect(report.candidateAudits?.[1]?.blockingIssues).toEqual(['Ahorro no sustentado']);
  });

  it('zeros model-provided savings when the recommendation has no priced alternative proof', () => {
    const recommendation = {
      id: 'rec-1',
      cloudAccountId: 'account-1',
      type: 'RIGHTSIZING',
      status: 'PENDING',
      severity: 'HIGH',
      title: 'Revisar capacidad',
      description: 'Validar capacidad con métricas.',
      evidence: { potentialMonthlySavings: 23.63, observedCost: 169 },
      currency: 'USD',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as FinOpsRecommendation;

    const plan = parseExecutionPlan(JSON.stringify({
      summary: 'Plan manual de validación.',
      scope: { cloudAccountId: 'account-1' },
      prerequisites: ['Confirmar ventana.'],
      steps: ['Validar métricas.'],
      validation: ['Comparar resultados.'],
      risks: ['Puede variar la carga.'],
      rollback: ['Restaurar la capacidad anterior.'],
      successCriteria: ['Mantener el servicio estable.'],
      estimatedSavings: { amount: 169, currency: 'USD' },
    }), recommendation);

    expect(plan.estimatedSavings).toMatchObject({
      amount: 0,
      currency: 'USD',
      status: 'POTENTIAL_NOT_VERIFIED',
    });
  });

  it('copies only the server-verified savings calculation into a plan', () => {
    const recommendation = {
      id: 'rec-1',
      cloudAccountId: 'account-1',
      type: 'RIGHTSIZING',
      status: 'PENDING',
      severity: 'HIGH',
      title: 'Revisar capacidad',
      description: 'Validar capacidad con métricas.',
      estimatedMonthlySavings: 23.63,
      currency: 'USD',
      evidence: {
        savingsCalculation: {
          provenance: 'SERVER_DETERMINISTIC',
          version: 'priced-alternative/v1',
          status: 'CALCULATED',
          formula: 'BASELINE_MINUS_ALTERNATIVE_MONTHLY',
          baselineMonthlyCost: 80,
          alternativeMonthlyCost: 56.37,
          amount: 23.63,
          currency: 'USD',
          priceEvidenceRef: 'fixture:price-catalog:instance-type',
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as FinOpsRecommendation;

    const plan = parseExecutionPlan(JSON.stringify({
      summary: 'Plan manual de validación.',
      scope: { cloudAccountId: 'account-1' },
      prerequisites: ['Confirmar ventana.'],
      steps: ['Validar métricas.'],
      validation: ['Comparar resultados.'],
      risks: ['Puede variar la carga.'],
      rollback: ['Restaurar la configuración anterior.'],
      successCriteria: ['Mantener el servicio estable.'],
      estimatedSavings: { amount: 169, currency: 'USD', note: 'Texto no confiable.' },
    }), recommendation);

    expect(plan.estimatedSavings).toMatchObject({
      amount: 23.63,
      currency: 'USD',
      status: 'POTENTIAL_NOT_VERIFIED',
    });
    expect(plan.estimatedSavings).not.toHaveProperty('note', 'Texto no confiable.');
  });
});
