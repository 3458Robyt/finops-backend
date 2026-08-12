/** Escenarios de costo que se pueden comparar sin confundir ahorro estimado con verificado. */
export type CostForecastScenarioKind =
  | 'BASELINE'
  | 'CURRENT_TREND'
  | 'APPROVED'
  | 'EXECUTED'
  | 'VERIFIED';

/** Proyección mensual por escenario, derivada de forecasts y valor realizado. */
export interface CostForecastScenario {
  readonly scenario: CostForecastScenarioKind;
  readonly groupBy: 'total';
  readonly groupKey: 'TENANT';
  readonly forecastMonth: string;
  readonly predictedCost: number;
  readonly savingsApplied: number;
  readonly confidence: number;
  readonly currency: string;
  readonly sourceForecastIds: readonly string[];
  readonly evidence: {
    readonly forecastCount: number;
    readonly baselineSource: 'WEIGHTED_AVERAGE' | 'PREDICTED_COST';
    readonly savingsSource: 'NONE' | 'APPROVED_ESTIMATE' | 'EXECUTED_MEASUREMENT' | 'VERIFIED_MEASUREMENT';
    readonly savingsScope: 'TENANT' | 'FILTERED_SCOPE' | 'NOT_AVAILABLE';
  };
}
