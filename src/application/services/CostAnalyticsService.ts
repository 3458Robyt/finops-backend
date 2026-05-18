import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type {
  AnalyticsFilters,
  AnalyticsGroupBy,
  CostAnomaly,
  CostAnomalySeverity,
  CostForecast,
  CostTrend,
  ICostAnalyticsRepository,
  MonthlyCostPoint,
  MonthlyUsagePoint,
  PersistCostAnomalyInput,
  PersistCostForecastInput,
  UsageInsight,
  UsageInsightSeverity,
} from '../../domain/interfaces/ICostAnalyticsRepository.js';

export interface AnalyticsQuery {
  readonly tenantId: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly provider?: string;
  readonly cloudAccountId?: string;
  readonly serviceName?: string;
  readonly groupBy?: AnalyticsGroupBy;
}

export interface AnalyticsRecomputeResult {
  readonly anomalies: readonly CostAnomaly[];
  readonly forecasts: readonly CostForecast[];
  readonly trends: readonly CostTrend[];
  readonly usageInsights: readonly UsageInsight[];
  readonly insufficientData: boolean;
}

const minAbsoluteDelta = Number.parseFloat(process.env['ANOMALY_MIN_DELTA_USD'] ?? '10');
const mediumDeltaPercent = 25;
const highDeltaPercent = 50;
const criticalDeltaPercent = 100;

export class CostAnalyticsService {
  private readonly recomputeQueues = new Map<string, Promise<AnalyticsRecomputeResult>>();

  constructor(private readonly analyticsRepository: ICostAnalyticsRepository) {}

  public async getAnomalies(query: AnalyticsQuery): Promise<readonly CostAnomaly[]> {
    return this.analyticsRepository.findAnomalies(query.tenantId, this.toFilters(query));
  }

  public async getForecast(query: AnalyticsQuery): Promise<readonly CostForecast[]> {
    return this.analyticsRepository.findForecasts(query.tenantId, this.toFilters(query));
  }

  public async getTrends(query: AnalyticsQuery): Promise<readonly CostTrend[]> {
    const series = await this.analyticsRepository.getMonthlyCostSeries(query.tenantId, this.toFilters(query));
    return this.buildTrends(series);
  }

  public async getUsage(query: AnalyticsQuery): Promise<readonly MonthlyUsagePoint[]> {
    return this.analyticsRepository.getMonthlyUsageSeries(query.tenantId, this.toFilters(query));
  }

  public async getUnitEconomics(query: AnalyticsQuery): Promise<readonly MonthlyUsagePoint[]> {
    const series = await this.analyticsRepository.getMonthlyUsageSeries(query.tenantId, this.toFilters(query));
    return series
      .filter((point) => point.unitCost !== undefined)
      .sort((left, right) => (right.cost / Math.max(right.consumedQuantity, 1)) - (left.cost / Math.max(left.consumedQuantity, 1)))
      .slice(0, 50);
  }

  public async getEfficiencyInsights(query: AnalyticsQuery): Promise<readonly UsageInsight[]> {
    const series = await this.analyticsRepository.getMonthlyUsageSeries(query.tenantId, this.toFilters(query));
    return this.buildUsageInsights(series);
  }

  public async recompute(query: AnalyticsQuery): Promise<AnalyticsRecomputeResult> {
    const key = query.tenantId;
    const previous = this.recomputeQueues.get(key) ?? Promise.resolve(undefined);
    const current = previous
      .catch(() => undefined)
      .then(() => this.executeRecompute(query));

    this.recomputeQueues.set(key, current);

    try {
      return await current;
    } finally {
      if (this.recomputeQueues.get(key) === current) {
        this.recomputeQueues.delete(key);
      }
    }
  }

  private async executeRecompute(query: AnalyticsQuery): Promise<AnalyticsRecomputeResult> {
    const filters = this.toFilters(query);
    const groupBy = filters.groupBy ?? 'service';
    const series = await this.analyticsRepository.getMonthlyCostSeries(query.tenantId, {
      ...filters,
      groupBy,
    });
    const anomalies = await this.analyticsRepository.replaceAnomalies(
      query.tenantId,
      this.detectAnomalies(query.tenantId, series),
    );
    const forecasts = await this.analyticsRepository.replaceForecasts(
      query.tenantId,
      this.generateForecasts(query.tenantId, series),
    );

    return {
      anomalies,
      forecasts,
      trends: this.buildTrends(series),
      usageInsights: await this.getEfficiencyInsights(query),
      insufficientData: series.length < 3,
    };
  }

  private detectAnomalies(
    tenantId: string,
    series: readonly MonthlyCostPoint[],
  ): readonly PersistCostAnomalyInput[] {
    const byGroup = this.groupSeries(series);
    const detected: PersistCostAnomalyInput[] = [];

    for (const points of byGroup.values()) {
      const sorted = [...points].sort((left, right) => left.month.localeCompare(right.month));

      if (sorted.length < 2) {
        continue;
      }

      const current = sorted.at(-1);
      const history = sorted.slice(Math.max(0, sorted.length - 7), -1);

      if (current === undefined || history.length === 0) {
        continue;
      }

      const costs = history.map((point) => point.cost);
      const baseline = average(costs);
      const stddev = standardDeviation(costs);
      const deltaAmount = current.cost - baseline;
      const deltaPercent = baseline > 0 ? (deltaAmount / baseline) * 100 : 0;
      const zScore = stddev > 0 ? deltaAmount / stddev : undefined;

      if (
        deltaAmount < minAbsoluteDelta ||
        (deltaPercent < mediumDeltaPercent && (zScore ?? 0) < 1.5)
      ) {
        continue;
      }

      const severity = this.scoreSeverity(deltaPercent, zScore);
      const periodStart = new Date(current.month);
      const periodEnd = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));

      detected.push({
        tenantId,
        ...(current.cloudAccountId !== undefined ? { cloudAccountId: current.cloudAccountId } : {}),
        ...(current.provider !== undefined ? { provider: current.provider } : {}),
        ...(current.serviceName !== undefined ? { serviceName: current.serviceName } : {}),
        ...(current.resourceId !== undefined ? { resourceId: current.resourceId } : {}),
        ...(current.environment !== undefined ? { environment: current.environment } : {}),
        periodStart,
        periodEnd,
        baselineCost: roundCurrency(baseline),
        observedCost: roundCurrency(current.cost),
        deltaAmount: roundCurrency(deltaAmount),
        deltaPercent: round(deltaPercent, 4),
        ...(zScore !== undefined ? { zScore: round(zScore, 4) } : {}),
        severity,
        status: 'OPEN',
          explanation: `Oportunidad de costo en ${current.groupBy} ${current.groupKey}: ${round(deltaPercent, 1)}% sobre la linea base.`,
        evidence: {
          groupBy: current.groupBy,
          groupKey: current.groupKey,
          historyMonths: history.length,
          method: zScore !== undefined ? 'z-score + delta' : 'delta-threshold',
          currency: current.currency,
        },
      });
    }

    return detected
      .sort((left, right) => right.deltaAmount - left.deltaAmount)
      .slice(0, 25);
  }

  private generateForecasts(
    tenantId: string,
    series: readonly MonthlyCostPoint[],
  ): readonly PersistCostForecastInput[] {
    const byGroup = this.groupSeries(series);
    const forecasts: PersistCostForecastInput[] = [];

    for (const points of byGroup.values()) {
      const sorted = [...points].sort((left, right) => left.month.localeCompare(right.month));

      if (sorted.length < 3) {
        continue;
      }

      const lastPoint = sorted.at(-1);

      if (lastPoint === undefined) {
        continue;
      }

      const lastThree = sorted.slice(-3);
      const costs = lastThree.map((point) => point.cost);
      const weightedAverage = ((costs[0] ?? 0) * 0.2) + ((costs[1] ?? 0) * 0.3) + ((costs[2] ?? 0) * 0.5);
      const trend = (costs.at(-1) ?? 0) - (costs[0] ?? 0);
      const monthlyTrend = trend / Math.max(lastThree.length - 1, 1);
      const variance = standardDeviation(costs);
      const confidence = Math.max(0.45, Math.min(0.9, 1 - (variance / Math.max(weightedAverage, 1))));
      const lastMonth = new Date(lastPoint.month);

      for (let offset = 1; offset <= 3; offset += 1) {
        const forecastMonth = new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + offset, 1));
        const predictedCost = Math.max(0, weightedAverage + (monthlyTrend * offset));
        const spread = Math.max(variance, predictedCost * (1 - confidence));

        forecasts.push({
          tenantId,
          ...(lastPoint.cloudAccountId !== undefined ? { cloudAccountId: lastPoint.cloudAccountId } : {}),
          ...(lastPoint.provider !== undefined ? { provider: lastPoint.provider } : {}),
          ...(lastPoint.serviceName !== undefined ? { serviceName: lastPoint.serviceName } : {}),
          groupBy: lastPoint.groupBy,
          groupKey: lastPoint.groupKey,
          forecastMonth,
          predictedCost: roundCurrency(predictedCost),
          lowerBound: roundCurrency(Math.max(0, predictedCost - spread)),
          upperBound: roundCurrency(predictedCost + spread),
          method: 'weighted-moving-average-linear-trend',
          confidence: round(confidence, 4),
          currency: lastPoint.currency,
          evidence: {
            sourceMonths: lastThree.map((point) => point.month),
            weightedAverage: roundCurrency(weightedAverage),
            monthlyTrend: roundCurrency(monthlyTrend),
          },
        });
      }
    }

    return forecasts.slice(0, 60);
  }

  private buildTrends(series: readonly MonthlyCostPoint[]): readonly CostTrend[] {
    return [...this.groupSeries(series).entries()].map(([groupKey, points]) => {
      const sorted = [...points].sort((left, right) => left.month.localeCompare(right.month));
      const first = sorted[0];
      const last = sorted.at(-1);

      if (first === undefined || last === undefined) {
        throw new FinOpsBaseError('Invalid empty trend group', 'ANALYTICS_ERROR');
      }

      const totalCost = sorted.reduce((total, point) => total + point.cost, 0);
      const deltaAmount = last.cost - first.cost;
      const deltaPercent = first.cost > 0 ? (deltaAmount / first.cost) * 100 : 0;

      return {
        groupBy: last.groupBy,
        groupKey,
        ...(last.provider !== undefined ? { provider: last.provider } : {}),
        ...(last.cloudAccountId !== undefined ? { cloudAccountId: last.cloudAccountId } : {}),
        ...(last.serviceName !== undefined ? { serviceName: last.serviceName } : {}),
        points: sorted,
        totalCost: roundCurrency(totalCost),
        deltaAmount: roundCurrency(deltaAmount),
        deltaPercent: round(deltaPercent, 4),
        currency: last.currency,
      };
    }).sort((left, right) => right.totalCost - left.totalCost);
  }

  private buildUsageInsights(series: readonly MonthlyUsagePoint[]): readonly UsageInsight[] {
    if (series.length === 0) {
      return [];
    }

    const insights: UsageInsight[] = [];

    for (const points of this.groupUsageSeries(series).values()) {
      const sorted = [...points].sort((left, right) => left.month.localeCompare(right.month));
      const first = sorted[0];
      const current = sorted.at(-1);

      if (first === undefined || current === undefined) {
        continue;
      }

      if (sorted.length < 2) {
        insights.push(this.toUsageInsight({
          point: current,
          kind: 'INSUFFICIENT_USAGE_DATA',
          severity: 'INFO',
          title: `Datos de consumo insuficientes para ${current.groupKey}`,
          description: `FOCUS trae consumo en ${current.consumedUnit}, pero solo hay ${sorted.length} periodo disponible para comparar tendencia.`,
        }));
        continue;
      }

      const deltaConsumptionPercent = percentDelta(first.consumedQuantity, current.consumedQuantity);
      const deltaCostPercent = percentDelta(first.cost, current.cost);
      const currentUnitCost = current.unitCost ?? 0;
      const firstUnitCost = first.unitCost ?? 0;
      const deltaUnitCostPercent = percentDelta(firstUnitCost, currentUnitCost);

      if (deltaConsumptionPercent >= 30 && current.consumedQuantity > first.consumedQuantity) {
        insights.push(this.toUsageInsight({
          point: current,
          kind: 'CONSUMPTION_GROWTH',
          severity: this.scoreUsageSeverity(deltaConsumptionPercent),
          title: `Consumo creciente en ${current.groupKey}`,
          description: `El consumo FOCUS aumento ${round(deltaConsumptionPercent, 1)}% en ${current.consumedUnit}; validar si el crecimiento corresponde a demanda real.`,
          deltaConsumptionPercent,
          deltaCostPercent,
        }));
      }

      if (deltaUnitCostPercent >= 20 && current.unitCost !== undefined && first.unitCost !== undefined) {
        insights.push(this.toUsageInsight({
          point: current,
          kind: 'UNIT_COST_INCREASE',
          severity: this.scoreUsageSeverity(deltaUnitCostPercent),
          title: `Costo unitario creciente en ${current.groupKey}`,
          description: `El costo por ${current.consumedUnit} aumento ${round(deltaUnitCostPercent, 1)}%; revisar descuentos, forma de consumo o cambios de precio.`,
          deltaConsumptionPercent,
          deltaCostPercent,
        }));
      }

      if (deltaCostPercent - deltaConsumptionPercent >= 25 && current.cost > 0) {
        insights.push(this.toUsageInsight({
          point: current,
          kind: 'COST_USAGE_DIVERGENCE',
          severity: this.scoreUsageSeverity(deltaCostPercent - deltaConsumptionPercent),
          title: `Costo crece mas que el consumo en ${current.groupKey}`,
          description: `El costo aumento ${round(deltaCostPercent, 1)}% y el consumo ${round(deltaConsumptionPercent, 1)}%; requiere investigacion antes de estimar ahorro.`,
          deltaConsumptionPercent,
          deltaCostPercent,
        }));
      }

      if (current.consumedQuantity > 0 && current.cost === 0) {
        insights.push(this.toUsageInsight({
          point: current,
          kind: 'HIGH_USAGE_LOW_COST',
          severity: 'LOW',
          title: `Consumo sin costo directo en ${current.groupKey}`,
          description: `FOCUS reporta ${round(current.consumedQuantity, 2)} ${current.consumedUnit} con costo cero; conservarlo como senal de consumo, no como ahorro directo.`,
          deltaConsumptionPercent,
          deltaCostPercent,
        }));
      }
    }

    return insights
      .sort((left, right) => this.usageSeverityWeight(right.severity) - this.usageSeverityWeight(left.severity))
      .slice(0, 25);
  }

  private toUsageInsight(input: {
    readonly point: MonthlyUsagePoint;
    readonly kind: UsageInsight['kind'];
    readonly severity: UsageInsightSeverity;
    readonly title: string;
    readonly description: string;
    readonly deltaConsumptionPercent?: number;
    readonly deltaCostPercent?: number;
  }): UsageInsight {
    const { point } = input;

    return {
      id: [
        input.kind,
        point.groupBy,
        point.groupKey,
        point.month.slice(0, 10),
      ].join(':'),
      kind: input.kind,
      severity: input.severity,
      groupBy: point.groupBy,
      groupKey: point.groupKey,
      ...(point.provider !== undefined ? { provider: point.provider } : {}),
      ...(point.cloudAccountId !== undefined ? { cloudAccountId: point.cloudAccountId } : {}),
      ...(point.serviceName !== undefined ? { serviceName: point.serviceName } : {}),
      ...(point.resourceId !== undefined ? { resourceId: point.resourceId } : {}),
      ...(point.environment !== undefined ? { environment: point.environment } : {}),
      title: input.title,
      description: input.description,
      consumedQuantity: round(point.consumedQuantity, 4),
      consumedUnit: point.consumedUnit,
      cost: roundCurrency(point.cost),
      ...(point.unitCost !== undefined ? { unitCost: round(point.unitCost, 8) } : {}),
      ...(input.deltaConsumptionPercent !== undefined ? { deltaConsumptionPercent: round(input.deltaConsumptionPercent, 4) } : {}),
      ...(input.deltaCostPercent !== undefined ? { deltaCostPercent: round(input.deltaCostPercent, 4) } : {}),
      evidenceLevel: 'COST_AND_USAGE',
      currency: point.currency,
      evidence: {
        source: 'FOCUS',
        limitation: 'FOCUS aporta consumo facturado, no metricas tecnicas como CPU, memoria, IOPS o throughput.',
        month: point.month,
        metricCount: point.metricCount,
      },
    };
  }

  private groupSeries(series: readonly MonthlyCostPoint[]): Map<string, MonthlyCostPoint[]> {
    const groups = new Map<string, MonthlyCostPoint[]>();

    for (const point of series) {
      const key = point.groupKey;
      const existing = groups.get(key) ?? [];
      existing.push(point);
      groups.set(key, existing);
    }

    return groups;
  }

  private groupUsageSeries(series: readonly MonthlyUsagePoint[]): Map<string, MonthlyUsagePoint[]> {
    const groups = new Map<string, MonthlyUsagePoint[]>();

    for (const point of series) {
      const key = `${point.groupBy}:${point.groupKey}:${point.consumedUnit}`;
      const existing = groups.get(key) ?? [];
      existing.push(point);
      groups.set(key, existing);
    }

    return groups;
  }

  private scoreUsageSeverity(deltaPercent: number): UsageInsightSeverity {
    if (deltaPercent >= 100) {
      return 'HIGH';
    }

    if (deltaPercent >= 50) {
      return 'MEDIUM';
    }

    return 'LOW';
  }

  private usageSeverityWeight(severity: UsageInsightSeverity): number {
    switch (severity) {
      case 'HIGH':
        return 3;
      case 'MEDIUM':
        return 2;
      case 'LOW':
        return 1;
      case 'INFO':
      default:
        return 0;
    }
  }

  private scoreSeverity(deltaPercent: number, zScore: number | undefined): CostAnomalySeverity {
    if (deltaPercent >= criticalDeltaPercent || (zScore ?? 0) >= 3) {
      return 'CRITICAL';
    }

    if (deltaPercent >= highDeltaPercent || (zScore ?? 0) >= 2) {
      return 'HIGH';
    }

    if (deltaPercent >= mediumDeltaPercent || (zScore ?? 0) >= 1.5) {
      return 'MEDIUM';
    }

    return 'LOW';
  }

  private toFilters(query: AnalyticsQuery): AnalyticsFilters {
    return {
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to } : {}),
      ...(query.provider !== undefined ? { provider: query.provider } : {}),
      ...(query.cloudAccountId !== undefined ? { cloudAccountId: query.cloudAccountId } : {}),
      ...(query.serviceName !== undefined ? { serviceName: query.serviceName } : {}),
      ...(query.groupBy !== undefined ? { groupBy: query.groupBy } : {}),
    };
  }
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }

  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function percentDelta(baseline: number, observed: number): number {
  if (baseline === 0) {
    return observed > 0 ? 100 : 0;
  }

  return ((observed - baseline) / baseline) * 100;
}

function roundCurrency(value: number): number {
  return round(value, 2);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
