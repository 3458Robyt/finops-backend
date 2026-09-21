import { describe, expect, test, vi } from 'vitest';
import type { IAiGateway } from '../../../domain/interfaces/IAiGateway.js';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import { FinOpsArtifactGenerator } from './FinOpsArtifactGenerator.js';

const snapshot: CostAnalyticsSnapshot = {
  tenantId: 'tenant-demo',
  periodStart: '2026-09-01',
  periodEnd: '2026-10-01',
  totalCost: 169,
  currency: 'USD',
  metricCount: 1,
  providers: [{ provider: 'AWS', totalCost: 169, metricCount: 1 }],
  accounts: [{ cloudAccountId: 'acc-prod-aws', provider: 'AWS', name: 'Producción', totalCost: 169, metricCount: 1 }],
  services: [],
  environments: [],
  topResources: [],
};

const recommendation = {
  id: 'rec-1',
  cloudAccountId: 'acc-prod-aws',
  cloudResourceId: 'cloud-resource-1',
  type: 'RIGHTSIZING',
  origin: 'AI_GENERATED',
  status: 'PENDING',
  severity: 'MEDIUM',
  title: 'Revisar capacidad',
  description: 'Validar la capacidad con evidencia técnica.',
  estimatedMonthlySavings: 42.25,
  currency: 'USD',
  evidence: {
    observedCost: 169,
    normalizedMonthlyCost: 169,
    potentialMonthlySavings: 42.25,
  },
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
} as FinOpsRecommendation;

function plan(steps: string[]): string {
  return JSON.stringify({
    summary: 'Plan manual de validación de capacidad.',
    scope: { cloudAccountId: 'acc-prod-aws', cloudResourceId: 'cloud-resource-1' },
    prerequisites: ['Confirmar responsable y ventana de revisión.'],
    steps,
    validation: ['Comparar las métricas y el costo autorizado de 169 USD.'],
    risks: ['La capacidad puede ser insuficiente si cambia la carga.'],
    rollback: ['Restaurar la configuración anterior si la validación falla.'],
    successCriteria: ['La decisión queda documentada y es reversible.'],
    estimatedSavings: { amount: 42.25, currency: 'USD', status: 'POTENTIAL_NOT_VERIFIED' },
  });
}

function approvedAudit(): string {
  return JSON.stringify({
    verdict: 'APPROVED',
    score: 95,
    checks: [],
    blockingIssues: [],
    requiredChanges: [],
  });
}

describe('FinOpsArtifactGenerator execution plans', () => {
  test('repairs a plan rejected by deterministic manual-governance checks before persistence', async () => {
    const generateText = vi.fn()
      .mockResolvedValueOnce(plan(['Ejecutar manualmente el cambio autorizado.']))
      .mockResolvedValueOnce(approvedAudit())
      .mockResolvedValueOnce(plan([
        'Si el responsable obtiene aprobación externa explícita, la persona autorizada puede ejecutar manualmente el cambio.',
      ]))
      .mockResolvedValueOnce(approvedAudit());
    const generator = new FinOpsArtifactGenerator(
      { generateText } as unknown as IAiGateway,
      { record: vi.fn().mockResolvedValue(undefined) },
      'generator-model',
      'auditor-model',
      { timeoutMs: 90_000, maxRetries: 0, reasoningEffort: 'low' },
    );

    const result = await generator.generateAuditedPlan(
      'tenant-demo',
      'user-demo',
      snapshot,
      recommendation,
      'prompt de prueba',
    );

    expect(generateText).toHaveBeenCalledTimes(4);
    expect(result.auditReport.verdict).toBe('APPROVED');
    expect(result.auditReport.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'deterministic:manualGovernance', passed: true }),
      expect.objectContaining({ name: 'deterministic:costProvenance', passed: true }),
    ]));
  });
});
