import type { CostAnalyticsSnapshot } from '../../../../domain/interfaces/ICostAnalyticsRepository.js';

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
];
