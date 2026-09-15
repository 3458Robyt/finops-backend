import { describe, expect, it } from 'vitest';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import { parseAuditReport, parseExecutionPlan } from './finOpsAiResponseParser.js';

describe('finOpsAiResponseParser', () => {
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

  it('restores the factual potential savings when a plan returns zero', () => {
    const recommendation = {
      id: 'rec-1',
      cloudAccountId: 'account-1',
      type: 'RIGHTSIZING',
      status: 'PENDING',
      severity: 'HIGH',
      title: 'Revisar capacidad',
      description: 'Validar capacidad con métricas.',
      evidence: { potentialMonthlySavings: 23.63 },
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
      estimatedSavings: { amount: 0, currency: 'USD' },
    }), recommendation);

    expect(plan.estimatedSavings).toMatchObject({
      amount: 23.63,
      currency: 'USD',
      status: 'POTENTIAL_NOT_VERIFIED',
    });
  });
});
