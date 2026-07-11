import type { CostAnalyticsSnapshot } from '../../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { RecommendationEvidenceSnapshot } from '../RecommendationEvidenceSnapshot.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Escenarios dorados (golden scenarios) del agente IA FinOps
 * ═══════════════════════════════════════════════════════════════
 *
 * Catálogo de escenarios sintéticos y deterministas para evaluar la calidad del
 * agente sin depender del modelo real ni de datos productivos. Cada escenario
 * combina un snapshot factual sintético con una respuesta "scripteada" (el JSON
 * crudo que produciría el modelo) y el resultado esperado al pasarla por el
 * pipeline real de parsing + rúbrica.
 *
 * Uso: el runner ({@link ./goldenScenarioRunner}) ejecuta cada escenario de
 * forma offline (sin LLM) y compara el resultado con `expectedOutcome`. También
 * sirven de base para una evaluación online opcional contra el modelo real.
 *
 * Importante: todos los datos están marcados como sintéticos; no representan
 * costos ni recursos reales de ningún tenant.
 *
 * @module application/services/ai/evaluation/goldenScenarios
 */

/** Resultado esperado de un escenario al pasar por parsing + rúbrica. */
export type GoldenOutcome =
  /** El parser acepta los borradores y la rúbrica los aprueba. */
  | 'PARSED_AND_PASSED'
  /** El parser acepta los borradores pero la rúbrica detecta un problema. */
  | 'PARSED_BUT_FAILED'
  /** El parser rechaza la respuesta (no quedan borradores válidos). */
  | 'PARSE_REJECTED';

/** Definición de un escenario dorado de recomendaciones. */
export interface GoldenScenario {
  /** Nombre legible y estable del escenario. */
  readonly name: string;
  /** Snapshot factual sintético usado como contexto y fuente de cuentas. */
  readonly snapshot: CostAnalyticsSnapshot;
  /** Respuesta cruda del modelo (texto JSON, como la devolvería el LLM). */
  readonly scriptedRecommendationResponse: string;
  /** Recurso de un análisis aislado; activa la comprobación exacta de evidencia. */
  readonly scopedExternalResourceId?: string;
  /** Evidencia técnica canónica; cuando existe, la rúbrica exige referencias exactas. */
  readonly technicalEvidenceSnapshot?: RecommendationEvidenceSnapshot;
  /** Resultado esperado del pipeline offline. */
  readonly expectedOutcome: GoldenOutcome;
}

/** Construye un snapshot sintético de costos para los escenarios. */
function buildSyntheticSnapshot(): CostAnalyticsSnapshot {
  return {
    tenantId: 'tenant-demo',
    periodStart: '2026-04-01',
    periodEnd: '2026-05-01',
    totalCost: 1000,
    currency: 'USD',
    metricCount: 5000,
    providers: [{ provider: 'AWS', totalCost: 1000, metricCount: 5000 }],
    accounts: [
      {
        cloudAccountId: 'acc-prod-aws',
        provider: 'AWS',
        name: 'AWS Producción (demo)',
        totalCost: 700,
        metricCount: 3000,
      },
      {
        cloudAccountId: 'acc-dev-aws',
        provider: 'AWS',
        name: 'AWS Desarrollo (demo)',
        totalCost: 300,
        metricCount: 2000,
      },
    ],
    services: [
      { serviceName: 'Amazon S3', provider: 'AWS', totalCost: 420, metricCount: 1500 },
      { serviceName: 'Amazon EC2', provider: 'AWS', totalCost: 580, metricCount: 3500 },
    ],
    environments: [{ environment: 'prod', totalCost: 700, metricCount: 3000 }],
    topResources: [
      { resourceId: 'bucket-logs', serviceName: 'Amazon S3', provider: 'AWS', totalCost: 220, metricCount: 600 },
    ],
    topUsage: [
      {
        serviceName: 'Amazon S3',
        provider: 'AWS',
        consumedQuantity: 12000,
        consumedUnit: 'GB-Mes',
        totalCost: 420,
        unitCost: 0.035,
        currency: 'USD',
        metricCount: 1500,
      },
    ],
  };
}

const snapshot = buildSyntheticSnapshot();

/** Serializa una respuesta de recomendaciones como lo haría el modelo. */
function scriptResponse(recommendations: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ recommendations });
}

function buildCanonicalTechnicalEvidence(input: {
  readonly readiness?: 'GENERATABLE' | 'VALIDATION_ONLY';
  readonly blockers?: readonly string[];
  readonly ruleMatches?: readonly string[];
  readonly latestSampledAt?: string;
  readonly sampleCount?: number;
  readonly coverageDays?: number;
} = {}): RecommendationEvidenceSnapshot {
  const latestSampledAt = input.latestSampledAt ?? '2026-04-30T23:30:00.000Z';
  const rule = {
    externalResourceId: 'i-abc123',
    cloudResourceId: 'cloud-resource-demo-1',
    provider: 'AWS',
    readiness: input.readiness ?? 'GENERATABLE',
    evidenceStrength: 'HIGH' as const,
    recommendedActionType: input.readiness === 'VALIDATION_ONLY' ? 'PERFORMANCE_CAPACITY_REVIEW' as const : 'RIGHTSIZING' as const,
    ruleMatches: input.ruleMatches ?? ['CPU_STRONG_UNDERUTILIZATION', 'MEMORY_LOW_UTILIZATION'],
    blockers: input.blockers ?? [],
    sourceFacts: ['Métricas técnicas canónicas de CPU, memoria, red y disco.'],
    technicalEvidenceRefs: [`resource_metric_samples:i-abc123:CpuUtilization:${latestSampledAt}`],
    metricSummary: [],
    maxTechnicalSavingsRate: input.readiness === 'VALIDATION_ONLY' ? 0 : 0.25,
  };
  return {
    version: '1',
    hash: `golden-${latestSampledAt}`,
    tenantId: 'tenant-demo',
    periodStart: '2026-04-01',
    periodEnd: '2026-05-01',
    generatedAt: '2026-05-01T00:00:00.000Z',
    availability: 'COST_USAGE_AND_TECHNICAL_AVAILABLE',
    resources: [{
      externalResourceId: 'i-abc123',
      cloudResourceId: 'cloud-resource-demo-1',
      provider: 'AWS',
      linkQuality: 'COST_AND_TECHNICAL',
      cost: { totalCost: 160, currency: 'USD', focusMetricCount: 96 },
      usage: [],
      metrics: [
        { metricName: 'CpuUtilization', metricUnit: 'Percent', sampleCount: input.sampleCount ?? 96, coverageDays: input.coverageDays ?? 14, min: 1, max: 28, avg: 8, p50: 8, p95: 15, p99: 28, latest: 8, firstSampledAt: '2026-04-16T00:00:00.000Z', latestSampledAt, evidenceRef: `resource_metric_samples:i-abc123:CpuUtilization:${latestSampledAt}` },
        { metricName: 'MemoryUtilization', metricUnit: 'Percent', sampleCount: input.sampleCount ?? 96, coverageDays: input.coverageDays ?? 14, min: 10, max: 45, avg: 22, p50: 22, p95: 40, p99: 45, latest: 22, firstSampledAt: '2026-04-16T00:00:00.000Z', latestSampledAt, evidenceRef: `resource_metric_samples:i-abc123:MemoryUtilization:${latestSampledAt}` },
        { metricName: 'NetworkUtilization', metricUnit: 'Percent', sampleCount: input.sampleCount ?? 96, coverageDays: input.coverageDays ?? 14, min: 1, max: 35, avg: 9, p50: 9, p95: 20, p99: 35, latest: 9, firstSampledAt: '2026-04-16T00:00:00.000Z', latestSampledAt, evidenceRef: `resource_metric_samples:i-abc123:NetworkUtilization:${latestSampledAt}` },
        { metricName: 'DiskUtilization', metricUnit: 'Percent', sampleCount: input.sampleCount ?? 96, coverageDays: input.coverageDays ?? 14, min: 5, max: 48, avg: 20, p50: 20, p95: 40, p99: 48, latest: 20, firstSampledAt: '2026-04-16T00:00:00.000Z', latestSampledAt, evidenceRef: `resource_metric_samples:i-abc123:DiskUtilization:${latestSampledAt}` },
      ],
      ruleEvaluation: rule,
    }],
    deterministicRules: [rule],
  };
}

/**
 * Catálogo de escenarios dorados. Cubre: caso bueno con consumo, caso FOCUS-only
 * honesto, caso con cuenta inventada (rechazado por el parser) y caso de ahorro
 * irreal (parseado pero reprobado por la rúbrica).
 */
export const goldenScenarios: readonly GoldenScenario[] = [
  {
    name: 'recomendacion-buena-cost-and-usage',
    snapshot,
    scriptedRecommendationResponse: scriptResponse([
      {
        cloudAccountId: 'acc-prod-aws',
        type: 'STORAGE_LIFECYCLE',
        severity: 'MEDIUM',
        title: 'Aplicar ciclo de vida a buckets S3 de logs',
        description: 'Mover objetos antiguos del bucket de logs a almacenamiento frío para reducir costo.',
        estimatedMonthlySavings: 80,
        currency: 'USD',
        evidence: { evidenceLevel: 'COST_AND_USAGE', serviceName: 'Amazon S3' },
      },
    ]),
    expectedOutcome: 'PARSED_AND_PASSED',
  },
  {
    name: 'recomendacion-focus-only-honesta',
    snapshot,
    scriptedRecommendationResponse: scriptResponse([
      {
        cloudAccountId: 'acc-prod-aws',
        type: 'RIGHTSIZING',
        severity: 'LOW',
        title: 'Revisar dimensionamiento de EC2',
        description: 'El costo de EC2 es alto; validar utilización técnica antes de redimensionar.',
        estimatedMonthlySavings: 50,
        currency: 'USD',
        evidence: { evidenceLevel: 'COST_ONLY', requiresTechnicalValidation: true },
      },
    ]),
    expectedOutcome: 'PARSED_AND_PASSED',
  },
  {
    name: 'recomendacion-recurso-aislado-correcto',
    snapshot,
    scopedExternalResourceId: 'bucket-logs',
    scriptedRecommendationResponse: scriptResponse([
      {
        cloudAccountId: 'acc-prod-aws',
        type: 'STORAGE_LIFECYCLE',
        severity: 'MEDIUM',
        title: 'Aplicar ciclo de vida al bucket de logs',
        description: 'Revisar el ciclo de vida del recurso solicitado antes de mover objetos.',
        estimatedMonthlySavings: 80,
        currency: 'USD',
        evidence: { evidenceLevel: 'COST_AND_USAGE', externalResourceId: 'bucket-logs' },
      },
    ]),
    expectedOutcome: 'PARSED_AND_PASSED',
  },
  {
    name: 'recomendacion-recurso-de-otro-tenant-rechazada',
    snapshot,
    scopedExternalResourceId: 'bucket-logs',
    scriptedRecommendationResponse: scriptResponse([
      {
        cloudAccountId: 'acc-prod-aws',
        type: 'STORAGE_LIFECYCLE',
        severity: 'MEDIUM',
        title: 'Optimizar un recurso ajeno',
        description: 'No debe recomendarse un recurso que no fue solicitado.',
        estimatedMonthlySavings: 80,
        currency: 'USD',
        evidence: { evidenceLevel: 'COST_AND_USAGE', externalResourceId: 'bucket-other-tenant' },
      },
    ]),
    expectedOutcome: 'PARSED_BUT_FAILED',
  },
  {
    name: 'recomendacion-cuenta-inventada-rechazada',
    snapshot,
    scriptedRecommendationResponse: scriptResponse([
      {
        cloudAccountId: 'acc-inexistente-999',
        type: 'STORAGE_LIFECYCLE',
        severity: 'HIGH',
        title: 'Optimizar cuenta inexistente',
        description: 'Recomendación sobre una cuenta que no existe en el snapshot.',
        estimatedMonthlySavings: 120,
        currency: 'USD',
        evidence: { evidenceLevel: 'COST_AND_USAGE' },
      },
    ]),
    expectedOutcome: 'PARSE_REJECTED',
  },
  {
    name: 'recomendacion-ahorro-irreal-reprobada',
    snapshot,
    scriptedRecommendationResponse: scriptResponse([
      {
        cloudAccountId: 'acc-prod-aws',
        type: 'STORAGE_LIFECYCLE',
        severity: 'HIGH',
        title: 'Ahorro exagerado',
        description: 'Promete un ahorro mayor que el costo total del periodo.',
        estimatedMonthlySavings: 999999,
        currency: 'USD',
        evidence: { evidenceLevel: 'COST_AND_USAGE' },
      },
    ]),
    expectedOutcome: 'PARSED_BUT_FAILED',
  },
  {
    name: 'rightsizing-tecnico-con-evidencia-fuerte',
    snapshot,
    scriptedRecommendationResponse: scriptResponse([
      {
        cloudAccountId: 'acc-prod-aws',
        type: 'RIGHTSIZING',
        severity: 'MEDIUM',
        title: 'Reducir capacidad de instancia EC2 con baja utilizacion',
        description: 'La instancia mantiene CPU baja con cobertura suficiente y muestras recientes.',
        estimatedMonthlySavings: 90,
        currency: 'USD',
        evidence: {
          evidenceLevel: 'COST_USAGE_AND_TECHNICAL',
          technicalEvidenceRefs: ['resource_metric_samples:i-abc123:CPUUtilization:2026-04'],
          cloudResourceId: 'cloud-resource-demo-1',
          externalResourceId: 'i-abc123',
          technicalSampleCount: 96,
          technicalCoverageDays: 14,
          latestTechnicalSampleAt: '2026-04-30T23:30:00.000Z',
        },
      },
    ]),
    expectedOutcome: 'PARSED_AND_PASSED',
  },
  {
    name: 'rightsizing-tecnico-sin-referencias-reprobado',
    snapshot,
    scriptedRecommendationResponse: scriptResponse([
      {
        cloudAccountId: 'acc-prod-aws',
        type: 'RIGHTSIZING',
        severity: 'HIGH',
        title: 'Reducir capacidad de instancia EC2',
        description: 'Afirma baja utilizacion pero no incluye referencias tecnicas verificables.',
        estimatedMonthlySavings: 90,
        currency: 'USD',
        evidence: {
          evidenceLevel: 'COST_USAGE_AND_TECHNICAL',
          technicalSampleCount: 96,
          technicalCoverageDays: 14,
          latestTechnicalSampleAt: '2026-04-30T23:30:00.000Z',
        },
      },
    ]),
    expectedOutcome: 'PARSED_BUT_FAILED',
  },
  {
    name: 'rightsizing-tecnico-evidencia-antigua-reprobado',
    snapshot,
    scriptedRecommendationResponse: scriptResponse([
      {
        cloudAccountId: 'acc-prod-aws',
        type: 'RIGHTSIZING',
        severity: 'MEDIUM',
        title: 'Reducir capacidad de instancia EC2',
        description: 'Usa evidencia tecnica demasiado antigua para justificar el cambio.',
        estimatedMonthlySavings: 70,
        currency: 'USD',
        evidence: {
          evidenceLevel: 'COST_USAGE_AND_TECHNICAL',
          technicalEvidenceRefs: ['resource_metric_samples:i-abc123:CPUUtilization:2026-03'],
          cloudResourceId: 'cloud-resource-demo-1',
          externalResourceId: 'i-abc123',
          technicalSampleCount: 96,
          technicalCoverageDays: 14,
          latestTechnicalSampleAt: '2026-03-15T00:00:00.000Z',
        },
      },
    ]),
    expectedOutcome: 'PARSED_BUT_FAILED',
  },
  {
    name: 'rightsizing-bloqueado-por-cpu-alta-reprobado',
    snapshot,
    scriptedRecommendationResponse: scriptResponse([
      {
        cloudAccountId: 'acc-prod-aws',
        type: 'RIGHTSIZING',
        severity: 'HIGH',
        title: 'Reducir capacidad de instancia EC2',
        description: 'Propone reducir capacidad aunque la CPU presenta saturacion sostenida.',
        estimatedMonthlySavings: 90,
        currency: 'USD',
        evidence: {
          candidateId: 'resource-1',
          evidenceLevel: 'COST_USAGE_AND_TECHNICAL',
          evidenceStrength: 'HIGH',
          technicalEvidenceRefs: ['resource_metric_samples:i-abc123:CPUUtilization:2026-04'],
          cloudResourceId: 'cloud-resource-demo-1',
          externalResourceId: 'i-abc123',
          technicalSampleCount: 96,
          technicalCoverageDays: 14,
          latestTechnicalSampleAt: '2026-04-30T23:30:00.000Z',
          blockers: ['CPU_SATURATION_RISK'],
          ruleMatches: ['CPU_HIGH_UTILIZATION'],
          sourceFacts: ['CPU cpu_utilization: avg=82, p95=88, p99=95, muestras=96, cobertura=14 dias.'],
        },
      },
    ]),
    expectedOutcome: 'PARSED_BUT_FAILED',
  },

  {
    name: 'cpu-baja-sin-memoria-validacion-pasa',
    snapshot,
    scriptedRecommendationResponse: scriptResponse([
      {
        cloudAccountId: 'acc-prod-aws',
        type: 'TECHNICAL_VALIDATION_REQUIRED',
        severity: 'LOW',
        title: 'Validar dimensionamiento de EC2 antes de reducir capacidad',
        description: 'La CPU esta baja, pero falta memoria; validar metricas tecnicas antes de ejecutar rightsizing.',
        estimatedMonthlySavings: 0,
        currency: 'USD',
        evidence: {
          candidateId: 'resource-1',
          evidenceLevel: 'COST_ONLY',
          evidenceStrength: 'MEDIUM',
          requiresTechnicalValidation: true,
          blockers: ['MISSING_MEMORY_METRIC'],
          ruleMatches: ['CPU_STRONG_UNDERUTILIZATION'],
          sourceFacts: ['CPU cpu_utilization: avg=8, p95=25, p99=35, muestras=96, cobertura=14 dias.'],
          assumptions: ['La memoria debe validarse antes de decidir cambio de tamano.'],
          confidence: 0.45,
        },
      },
    ]),
    expectedOutcome: 'PARSED_AND_PASSED',
  },
  {
    name: 'rightsizing-canonico-cpu-memoria-red-disco-verificable',
    snapshot,
    technicalEvidenceSnapshot: buildCanonicalTechnicalEvidence(),
    scriptedRecommendationResponse: scriptResponse([{
      cloudAccountId: 'acc-prod-aws',
      type: 'RIGHTSIZING',
      severity: 'MEDIUM',
      title: 'Reducir capacidad con métricas técnicas verificadas',
      description: 'CPU, memoria, red y disco permanecen dentro de rangos bajos durante el período observado.',
      estimatedMonthlySavings: 40,
      currency: 'USD',
      evidence: {
        evidenceLevel: 'COST_USAGE_AND_TECHNICAL',
        cloudResourceId: 'cloud-resource-demo-1',
        externalResourceId: 'i-abc123',
        technicalEvidenceRefs: ['resource_metric_samples:i-abc123:CpuUtilization:2026-04-30T23:30:00.000Z'],
        technicalSampleCount: 96,
        technicalCoverageDays: 14,
        latestTechnicalSampleAt: '2026-04-30T23:30:00.000Z',
      },
    }]),
    expectedOutcome: 'PARSED_AND_PASSED',
  },
  {
    name: 'rightsizing-bloqueado-por-red-y-disco',
    snapshot,
    technicalEvidenceSnapshot: buildCanonicalTechnicalEvidence({
      readiness: 'VALIDATION_ONLY',
      blockers: ['NETWORK_SATURATION_RISK', 'DISK_SATURATION_RISK'],
      ruleMatches: ['NETWORK_HIGH_UTILIZATION', 'DISK_HIGH_UTILIZATION'],
    }),
    scriptedRecommendationResponse: scriptResponse([{
      cloudAccountId: 'acc-prod-aws', type: 'RIGHTSIZING', severity: 'HIGH',
      title: 'Reducir capacidad pese a saturación de red y disco',
      description: 'Propone reducir capacidad ignorando señales técnicas contradictorias.',
      estimatedMonthlySavings: 40, currency: 'USD',
      evidence: {
        evidenceLevel: 'COST_USAGE_AND_TECHNICAL', cloudResourceId: 'cloud-resource-demo-1', externalResourceId: 'i-abc123',
        technicalEvidenceRefs: ['resource_metric_samples:i-abc123:CpuUtilization:2026-04-30T23:30:00.000Z'],
        technicalSampleCount: 96, technicalCoverageDays: 14, latestTechnicalSampleAt: '2026-04-30T23:30:00.000Z',
      },
    }]),
    expectedOutcome: 'PARSED_BUT_FAILED',
  },
  {
    name: 'rightsizing-canonico-con-evidencia-obsoleta',
    snapshot,
    technicalEvidenceSnapshot: buildCanonicalTechnicalEvidence({ latestSampledAt: '2026-03-01T00:00:00.000Z' }),
    scriptedRecommendationResponse: scriptResponse([{
      cloudAccountId: 'acc-prod-aws', type: 'RIGHTSIZING', severity: 'MEDIUM',
      title: 'Reducir capacidad con evidencia antigua', description: 'Usa métricas que ya no son recientes.',
      estimatedMonthlySavings: 40, currency: 'USD',
      evidence: {
        evidenceLevel: 'COST_USAGE_AND_TECHNICAL', cloudResourceId: 'cloud-resource-demo-1', externalResourceId: 'i-abc123',
        technicalEvidenceRefs: ['resource_metric_samples:i-abc123:CpuUtilization:2026-03-01T00:00:00.000Z'],
        technicalSampleCount: 96, technicalCoverageDays: 14, latestTechnicalSampleAt: '2026-03-01T00:00:00.000Z',
      },
    }]),
    expectedOutcome: 'PARSED_BUT_FAILED',
  },
  {
    name: 'rightsizing-canonico-con-cobertura-insuficiente',
    snapshot,
    technicalEvidenceSnapshot: buildCanonicalTechnicalEvidence({ sampleCount: 4, coverageDays: 2 }),
    scriptedRecommendationResponse: scriptResponse([{
      cloudAccountId: 'acc-prod-aws', type: 'RIGHTSIZING', severity: 'MEDIUM',
      title: 'Reducir capacidad con cuatro muestras', description: 'Afirma una conclusión técnica con cobertura insuficiente.',
      estimatedMonthlySavings: 40, currency: 'USD',
      evidence: {
        evidenceLevel: 'COST_USAGE_AND_TECHNICAL', cloudResourceId: 'cloud-resource-demo-1', externalResourceId: 'i-abc123',
        technicalEvidenceRefs: ['resource_metric_samples:i-abc123:CpuUtilization:2026-04-30T23:30:00.000Z'],
        technicalSampleCount: 4, technicalCoverageDays: 2, latestTechnicalSampleAt: '2026-04-30T23:30:00.000Z',
      },
    }]),
    expectedOutcome: 'PARSED_BUT_FAILED',
  },
  {
    name: 'rightsizing-canonico-con-metrica-inventada',
    snapshot,
    technicalEvidenceSnapshot: buildCanonicalTechnicalEvidence(),
    scriptedRecommendationResponse: scriptResponse([{
      cloudAccountId: 'acc-prod-aws', type: 'RIGHTSIZING', severity: 'MEDIUM',
      title: 'Reducir capacidad con métrica inexistente', description: 'Cita una métrica que no existe en la evidencia.',
      estimatedMonthlySavings: 40, currency: 'USD',
      evidence: {
        evidenceLevel: 'COST_USAGE_AND_TECHNICAL', cloudResourceId: 'cloud-resource-demo-1', externalResourceId: 'i-abc123',
        technicalEvidenceRefs: ['resource_metric_samples:i-abc123:InventedMetric:2026-04-30T23:30:00.000Z'],
        technicalSampleCount: 96, technicalCoverageDays: 14, latestTechnicalSampleAt: '2026-04-30T23:30:00.000Z',
      },
    }]),
    expectedOutcome: 'PARSED_BUT_FAILED',
  },
];
