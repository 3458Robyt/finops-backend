import type {
  AgentQualityRecommendationRow,
  AgentQualityReportQuery,
  AgentQualityTraceRow,
  IAgentQualityRepository,
} from '../../domain/interfaces/IAgentQualityRepository.js';
import type {
  AgentQualityDimensionMetric,
  AgentQualityMetric,
  AgentQualityReport,
  AgentQualityTraceMetrics,
} from '../../domain/models/AgentQuality.js';

export interface AgentQualityTokenPricing {
  readonly inputCostPerMillionTokensUsd?: number;
  readonly outputCostPerMillionTokensUsd?: number;
}

/** Builds tenant-scoped, honest quality proxies from persisted outcomes. */
export class AgentQualityService {
  constructor(
    private readonly repository: IAgentQualityRepository,
    private readonly pricing: AgentQualityTokenPricing = {},
  ) {}

  public async getReport(tenantId: string, days = 90, now = new Date()): Promise<AgentQualityReport> {
    const periodEnd = new Date(now);
    const periodStart = new Date(periodEnd.getTime() - days * 24 * 60 * 60 * 1000);
    const query: AgentQualityReportQuery = { tenantId, periodStart, periodEnd };
    const [recommendations, traces] = await Promise.all([
      this.repository.listRecommendationRows(query),
      this.repository.listTraceRows(query),
    ]);
    const dimensions = new Map<string, DimensionAccumulator>();
    const total = createAccumulator();

    for (const recommendation of recommendations) {
      const keys = [
        ['TYPE', recommendation.type],
        ['PROVIDER', recommendation.provider ?? 'PROVEEDOR_NO_IDENTIFICADO'],
        ...extractRuleKeys(recommendation.evidence).map((key) => ['RULE', key] as const),
      ] as const;
      addRecommendation(total, recommendation);
      for (const [dimension, key] of keys) {
        const accumulator = dimensions.get(`${dimension}:${key}`) ?? createAccumulator();
        addRecommendation(accumulator, recommendation);
        dimensions.set(`${dimension}:${key}`, accumulator);
      }
    }

    return {
      generatedAt: now,
      periodStart,
      periodEnd,
      totals: toMetric(total),
      dimensions: [...dimensions.entries()]
        .map(([compoundKey, accumulator]) => {
          const [dimension, ...keyParts] = compoundKey.split(':');
          return {
            ...toMetric(accumulator),
            dimension: dimension as AgentQualityDimensionMetric['dimension'],
            key: keyParts.join(':'),
          };
        })
        .sort((left, right) => right.generated - left.generated || left.key.localeCompare(right.key)),
      traces: toTraceMetrics(traces, this.pricing),
      notes: [
        'La tasa de aprobación es un proxy de calidad basado en decisiones humanas; no representa precisión de machine learning sin un conjunto de verdad etiquetado.',
        'El ahorro verificado solo usa mediciones con estado VERIFIED y valor observado persistido.',
        'Las recomendaciones sin regla determinística se agrupan como SIN_REGLA_DETERMINISTICA.',
      ],
    };
  }
}

interface DimensionAccumulator {
  generated: number;
  reviewed: number;
  approved: number;
  rejected: number;
  markedDone: number;
  abstained: number;
  insufficientEvidence: number;
  verified: number;
  estimatedSavings: number;
  verifiedSavings: number;
  errorPercentSum: number;
  errorPercentCount: number;
}

function createAccumulator(): DimensionAccumulator {
  return {
    generated: 0, reviewed: 0, approved: 0, rejected: 0, markedDone: 0,
    abstained: 0, insufficientEvidence: 0, verified: 0, estimatedSavings: 0,
    verifiedSavings: 0, errorPercentSum: 0, errorPercentCount: 0,
  };
}

function addRecommendation(accumulator: DimensionAccumulator, row: AgentQualityRecommendationRow): void {
  accumulator.generated += 1;
  if (row.decision !== undefined) {
    accumulator.reviewed += 1;
    if (row.decision === 'APPROVED') accumulator.approved += 1;
    if (row.decision === 'REJECTED') accumulator.rejected += 1;
    if (row.decision === 'MARKED_DONE') accumulator.markedDone += 1;
  }
  const evidence = asRecord(row.evidence);
  const abstained = row.type === 'TECHNICAL_VALIDATION_REQUIRED'
    || row.type === 'PERFORMANCE_CAPACITY_REVIEW'
    || evidence['requiresTechnicalValidation'] === true
    || evidence['readiness'] === 'VALIDATION_ONLY'
    || evidence['readiness'] === 'BLOCKED_NO_EVIDENCE';
  const insufficient = abstained
    && (evidence['evidenceStrength'] === 'LOW'
      || evidence['readiness'] === 'BLOCKED_NO_EVIDENCE'
      || hasEvidenceBlocker(evidence, 'INSUFFICIENT_TECHNICAL_COVERAGE'));
  if (abstained) accumulator.abstained += 1;
  if (insufficient) accumulator.insufficientEvidence += 1;
  const estimated = row.estimatedMonthlySavings ?? 0;
  accumulator.estimatedSavings += estimated;
  if (row.observedSavings !== undefined && row.observedSavings !== null) {
    accumulator.verified += 1;
    accumulator.verifiedSavings += row.observedSavings;
    if (Math.abs(estimated) > 0.000001) {
      accumulator.errorPercentSum += Math.abs(row.observedSavings - estimated) / Math.abs(estimated) * 100;
      accumulator.errorPercentCount += 1;
    }
  }
}

function toMetric(accumulator: DimensionAccumulator): AgentQualityMetric {
  return {
    generated: accumulator.generated,
    reviewed: accumulator.reviewed,
    approved: accumulator.approved,
    rejected: accumulator.rejected,
    markedDone: accumulator.markedDone,
    reviewRate: rate(accumulator.reviewed, accumulator.generated),
    approvalRate: rate(accumulator.approved, accumulator.reviewed),
    rejectionRate: rate(accumulator.rejected, accumulator.reviewed),
    abstained: accumulator.abstained,
    insufficientEvidence: accumulator.insufficientEvidence,
    verified: accumulator.verified,
    estimatedSavings: round(accumulator.estimatedSavings),
    verifiedSavings: round(accumulator.verifiedSavings),
    estimatedVsVerifiedErrorPercent: accumulator.errorPercentCount === 0
      ? null
      : round(accumulator.errorPercentSum / accumulator.errorPercentCount),
    verifiedOutcomeRate: rate(accumulator.verified, accumulator.approved),
  };
}

function toTraceMetrics(rows: readonly AgentQualityTraceRow[], pricing: AgentQualityTokenPricing): AgentQualityTraceMetrics {
  const successfulCalls = rows.filter((row) => row.status === 'SUCCESS').length;
  const latencies = rows.map((row) => row.latencyMs).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  const promptTokens = rows.reduce((total, row) => total + row.promptTokenEstimate, 0);
  const responseTokens = rows.reduce((total, row) => total + (row.responseTokenEstimate ?? 0), 0);
  const hasPricing = pricing.inputCostPerMillionTokensUsd !== undefined && pricing.outputCostPerMillionTokensUsd !== undefined;
  const estimatedCostUsd = hasPricing
    ? roundCost(promptTokens / 1_000_000 * pricing.inputCostPerMillionTokensUsd! + responseTokens / 1_000_000 * pricing.outputCostPerMillionTokensUsd!)
    : null;
  return {
    calls: rows.length,
    successfulCalls,
    failedCalls: rows.length - successfulCalls,
    successRate: rate(successfulCalls, rows.length),
    averageLatencyMs: latencies.length === 0 ? null : round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
    p95LatencyMs: latencies.length === 0 ? null : latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)]!,
    promptTokens,
    responseTokens,
    totalTokens: promptTokens + responseTokens,
    estimatedCostUsd,
    costEstimateAvailable: hasPricing,
  };
}

function extractRuleKeys(value: unknown): readonly string[] {
  const evidence = asRecord(value);
  const candidates: unknown[] = [evidence['ruleMatches']];
  const deterministic = evidence['deterministicRules'];
  if (Array.isArray(deterministic)) candidates.push(...deterministic.flatMap((item) => [asRecord(item)['ruleMatches']]));
  else candidates.push(asRecord(deterministic)['ruleMatches']);
  const snapshot = asRecord(evidence['recommendationEvidenceSnapshot']);
  for (const resource of Array.isArray(snapshot['resources']) ? snapshot['resources'] : []) {
    candidates.push(asRecord(asRecord(resource)['ruleEvaluation'])['ruleMatches']);
  }
  const rules = [...new Set(candidates.flatMap((item) => Array.isArray(item) ? item.filter((rule): rule is string => typeof rule === 'string') : []))];
  return rules.length > 0 ? rules : ['SIN_REGLA_DETERMINISTICA'];
}

function hasEvidenceBlocker(evidence: Record<string, unknown>, blocker: string): boolean {
  const direct = evidence['blockers'];
  const deterministic = asRecord(evidence['deterministicRules'])['blockers'];
  const values = [...(Array.isArray(direct) ? direct : []), ...(Array.isArray(deterministic) ? deterministic : [])];
  return values.includes(blocker);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : round(numerator / denominator * 100);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
