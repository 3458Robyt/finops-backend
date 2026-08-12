export interface TechnicalOptimizationRuleConfig {
  readonly version: string;
  readonly minimumSamples: number;
  readonly minimumCoverageDays: number;
  readonly recentSampleMaxAgeDays: number;
  readonly highUtilizationPercent: number;
  readonly cpuCriticalP99Percent: number;
  readonly sustainedHighUtilizationRatio: number;
  readonly cpuIdleAveragePercent: number;
  readonly cpuIdleP95Percent: number;
  readonly cpuStrongAveragePercent: number;
  readonly cpuStrongP95Percent: number;
  readonly cpuModerateAveragePercent: number;
  readonly cpuModerateP95Percent: number;
  readonly memoryLowAveragePercent: number;
  readonly memoryLowP95Percent: number;
  readonly auxiliaryLowAveragePercent: number;
  readonly auxiliaryLowP95Percent: number;
}

/**
 * Versioned defaults for the deterministic technical gate.
 *
 * These are conservative review thresholds, not provider SLAs. The SQL
 * summaries currently calculate the high-utilization ratio at 80%; callers
 * using another threshold must provide summaries calculated with that same
 * threshold or the ratio is intentionally ignored by the engine.
 */
export const defaultTechnicalOptimizationRuleConfig: TechnicalOptimizationRuleConfig = {
  version: 'technical-rules-2026-08-11.v1',
  minimumSamples: 48,
  minimumCoverageDays: 7,
  recentSampleMaxAgeDays: 7,
  highUtilizationPercent: 80,
  cpuCriticalP99Percent: 90,
  sustainedHighUtilizationRatio: 0.2,
  cpuIdleAveragePercent: 5,
  cpuIdleP95Percent: 10,
  cpuStrongAveragePercent: 10,
  cpuStrongP95Percent: 30,
  cpuModerateAveragePercent: 20,
  cpuModerateP95Percent: 50,
  memoryLowAveragePercent: 30,
  memoryLowP95Percent: 50,
  auxiliaryLowAveragePercent: 20,
  auxiliaryLowP95Percent: 50,
};
