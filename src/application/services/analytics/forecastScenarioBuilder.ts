import type { CostForecast } from '../../../domain/interfaces/costAnalytics/costAnalyticsModels.js';
import type {
  CostForecastScenario,
  CostForecastScenarioKind,
} from '../../../domain/interfaces/costAnalytics/costForecastScenarioModels.js';

export interface ForecastScenarioSavings {
  readonly approved: ReadonlyMap<string, number>;
  readonly executed: ReadonlyMap<string, number>;
  readonly verified: ReadonlyMap<string, number>;
  readonly scope: 'TENANT' | 'FILTERED_SCOPE' | 'NOT_AVAILABLE';
}

/** Construye escenarios agregados por tenant sin inventar datos técnicos. */
export function buildForecastScenarios(
  forecasts: readonly CostForecast[],
  savings: ForecastScenarioSavings,
): readonly CostForecastScenario[] {
  const groups = new Map<string, {
    readonly month: string;
    readonly currency: string;
    baseline: number;
    currentTrend: number;
    confidence: number;
    readonly ids: string[];
    readonly baselineSource: 'WEIGHTED_AVERAGE' | 'PREDICTED_COST';
  }>();

  for (const forecast of forecasts) {
    const key = `${forecast.forecastMonth}:${forecast.currency}`;
    const current = groups.get(key);
    const weightedAverage = readWeightedAverage(forecast.evidence);
    const baselineSource = weightedAverage === undefined ? 'PREDICTED_COST' : 'WEIGHTED_AVERAGE';
    if (current === undefined) {
      groups.set(key, {
        month: forecast.forecastMonth,
        currency: forecast.currency,
        baseline: weightedAverage ?? forecast.predictedCost,
        currentTrend: forecast.predictedCost,
        confidence: forecast.confidence,
        ids: [forecast.id],
        baselineSource,
      });
      continue;
    }
    current.baseline += weightedAverage ?? forecast.predictedCost;
    current.currentTrend += forecast.predictedCost;
    current.confidence = Math.min(current.confidence, forecast.confidence);
    current.ids.push(forecast.id);
  }

  const scenarios: CostForecastScenario[] = [];
  for (const group of groups.values()) {
    scenarios.push(createScenario(group, 'BASELINE', group.baseline, 0, savings.scope, 'NONE'));
    scenarios.push(createScenario(group, 'CURRENT_TREND', group.currentTrend, 0, savings.scope, 'NONE'));
    scenarios.push(createSavingsScenario(group, 'APPROVED', group.currentTrend, savings.approved.get(group.currency) ?? 0, savings.scope, 'APPROVED_ESTIMATE'));
    scenarios.push(createSavingsScenario(group, 'EXECUTED', group.currentTrend, savings.executed.get(group.currency) ?? 0, savings.scope, 'EXECUTED_MEASUREMENT'));
    scenarios.push(createSavingsScenario(group, 'VERIFIED', group.currentTrend, savings.verified.get(group.currency) ?? 0, savings.scope, 'VERIFIED_MEASUREMENT'));
  }

  return scenarios;
}

function createSavingsScenario(
  group: { readonly month: string; readonly currency: string; readonly currentTrend: number; readonly confidence: number; readonly ids: readonly string[]; readonly baselineSource: 'WEIGHTED_AVERAGE' | 'PREDICTED_COST' },
  scenario: Exclude<CostForecastScenarioKind, 'BASELINE' | 'CURRENT_TREND'>,
  currentTrend: number,
  savings: number,
  scope: ForecastScenarioSavings['scope'],
  savingsSource: 'APPROVED_ESTIMATE' | 'EXECUTED_MEASUREMENT' | 'VERIFIED_MEASUREMENT',
): CostForecastScenario {
  const applied = Math.min(Math.max(0, savings), Math.max(0, currentTrend));
  return createScenario(group, scenario, Math.max(0, currentTrend - applied), applied, scope, savingsSource);
}

function createScenario(
  group: { readonly month: string; readonly currency: string; readonly currentTrend?: number; readonly confidence: number; readonly ids: readonly string[]; readonly baselineSource: 'WEIGHTED_AVERAGE' | 'PREDICTED_COST' },
  scenario: CostForecastScenarioKind,
  predictedCost: number,
  savingsApplied: number,
  scope: ForecastScenarioSavings['scope'],
  savingsSource: CostForecastScenario['evidence']['savingsSource'],
): CostForecastScenario {
  return {
    scenario,
    groupBy: 'total',
    groupKey: 'TENANT',
    forecastMonth: group.month,
    predictedCost: round(predictedCost),
    savingsApplied: round(savingsApplied),
    confidence: round(group.confidence, 4),
    currency: group.currency,
    sourceForecastIds: group.ids,
    evidence: {
      forecastCount: group.ids.length,
      baselineSource: group.baselineSource,
      savingsSource,
      savingsScope: scope,
    },
  };
}

function readWeightedAverage(evidence: unknown): number | undefined {
  if (typeof evidence !== 'object' || evidence === null || !('weightedAverage' in evidence)) return undefined;
  const value = evidence.weightedAverage;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
