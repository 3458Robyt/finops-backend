import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import type { CostAllocationRuleInput } from '../../domain/interfaces/ICostAllocationRepository.js';
import type {
  AllocationBreakdown,
  AllocationSummary,
  CostAllocationMode,
  CostAllocationRule,
  CostAllocationRuleTarget,
  CostAllocationTarget,
} from '../../domain/models/CostAllocation.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';

export type Metric = {
  readonly chargePeriodStart: Date;
  readonly metricIdentityHash: string;
  readonly billedCost: Prisma.Decimal;
  readonly billingCurrency: string;
  readonly cloudAccountId: string;
  readonly provider: string;
  readonly serviceName: string;
  readonly regionId: string | null;
  readonly resourceId: string;
  readonly cloudResourceId: string | null;
  readonly resourceLinkReason: string | null;
  readonly tags: unknown;
};

export type AllocationLine = {
  readonly chargePeriodStart: Date;
  readonly metricIdentityHash: string;
  readonly sourceAmount: Prisma.Decimal;
  readonly allocationAmount: Prisma.Decimal;
  readonly allocationKey: string;
  readonly currency: string;
  readonly allocationMode: CostAllocationMode;
  readonly shared: boolean;
  readonly percentage?: number;
  readonly ruleId?: string;
  readonly cloudAccountId: string;
  readonly provider: string;
  readonly serviceName: string;
  readonly regionId: string | null;
  readonly resourceId: string;
  readonly cloudResourceId: string | null;
  readonly resourceLinkReason: string | null;
};

type AllocationResult = {
  readonly summaries: readonly AllocationSummary[];
  readonly lines: readonly AllocationLine[];
};

const allocationScale = 6;

export function summarize(metrics: readonly Metric[], rules: readonly CostAllocationRule[], periodStart: Date): readonly AllocationSummary[] {
  return allocate(metrics, rules, periodStart).summaries;
}

export function allocate(metrics: readonly Metric[], rules: readonly CostAllocationRule[], periodStart: Date): AllocationResult {
  validateExecutionRules(rules);
  const byCurrency = new Map<string, CurrencyAccumulator>();
  const lines: AllocationLine[] = [];
  for (const metric of metrics) {
    const bucket = byCurrency.get(metric.billingCurrency) ?? emptyCurrency();
    bucket.total = bucket.total.plus(metric.billedCost);
    const rule = matchesAny(metric, rules, periodStart);
    if (rule === undefined) {
      addGroup(bucket, { allocationKey: 'UNALLOCATED', currency: metric.billingCurrency, cost: metric.billedCost, metricCount: 1, resourceCount: resourceSet(metric), shared: false });
      lines.push(line(metric, metric.billedCost, 'UNALLOCATED', 'DIRECT', false));
    } else if (rule.allocationMode === 'SPLIT') {
      bucket.shared = bucket.shared.plus(metric.billedCost);
      const amounts = splitAmounts(metric.billedCost, rule.allocationTargets);
      for (const [index, target] of rule.allocationTargets.entries()) {
        const allocationAmount = amounts[index]!;
        addGroup(bucket, { allocationKey: allocationKey(target), currency: metric.billingCurrency, cost: allocationAmount, metricCount: 1, resourceCount: resourceSet(metric), shared: true, percentage: target.percentage, ruleId: rule.id, ...targetDimensions(target) });
        lines.push(line(metric, allocationAmount, allocationKey(target), 'SPLIT', true, target.percentage, rule.id));
      }
    } else {
      addGroup(bucket, { allocationKey: allocationKey(rule), currency: metric.billingCurrency, cost: metric.billedCost, metricCount: 1, resourceCount: resourceSet(metric), shared: false, percentage: 100, ruleId: rule.id, ...target(rule) });
      lines.push(line(metric, metric.billedCost, allocationKey(rule), 'DIRECT', false, 100, rule.id));
    }
    byCurrency.set(metric.billingCurrency, bucket);
  }
  for (const value of byCurrency.values()) {
    const groupedTotal = [...value.groups.values()].reduce((total, group) => total.plus(group.cost), new Prisma.Decimal(0));
    if (!groupedTotal.eq(value.total)) throw new FinOpsBaseError('Los totales asignados no cuadran por moneda', 'INTERNAL_ERROR');
  }
  const summaries = [...byCurrency.entries()].map(([currency, value]) => ({ period: periodStart.toISOString().slice(0, 7), currency, totalCost: toNumber(value.total), allocatedCost: toNumber(value.allocated.plus(value.shared)), unallocatedCost: toNumber(value.total.minus(value.allocated).minus(value.shared)), sharedCost: toNumber(value.shared), coveragePercent: value.total.isZero() ? 0 : round(toNumber(value.allocated.plus(value.shared).div(value.total).mul(100))), dimensions: [...value.groups.values()].map((group) => ({ ...group, cost: toNumber(group.cost), resourceCount: group.resources.size, resources: undefined })).map(({ resources: _resources, ...group }) => group).sort((a, b) => b.cost - a.cost) }));
  return { summaries, lines };
}

type CurrencyAccumulator = { total: Prisma.Decimal; allocated: Prisma.Decimal; shared: Prisma.Decimal; groups: Map<string, GroupAccumulator> };
type GroupInput = Omit<AllocationBreakdown, 'cost' | 'resourceCount'> & { cost: Prisma.Decimal; resourceCount: Set<string> };
type GroupAccumulator = { allocationKey: string; currency: string; cost: Prisma.Decimal; metricCount: number; resources: Set<string>; shared: boolean; percentage?: number; ruleId?: string } & CostAllocationTarget;

function emptyCurrency(): CurrencyAccumulator { return { total: new Prisma.Decimal(0), allocated: new Prisma.Decimal(0), shared: new Prisma.Decimal(0), groups: new Map() }; }
function addGroup(bucket: CurrencyAccumulator, value: GroupInput): void {
  const current: GroupAccumulator = bucket.groups.get(value.allocationKey) ?? { allocationKey: value.allocationKey, currency: value.currency, cost: new Prisma.Decimal(0), metricCount: 0, resources: new Set<string>(), shared: value.shared, ...(value.percentage === undefined ? {} : { percentage: value.percentage }), ...(value.ruleId === undefined ? {} : { ruleId: value.ruleId }), ...targetFromBreakdown(value) };
  current.cost = current.cost.plus(value.cost); current.metricCount += value.metricCount; current.shared = current.shared || value.shared; for (const resource of value.resourceCount) current.resources.add(resource); bucket.groups.set(value.allocationKey, current);
  if (value.allocationKey !== 'UNALLOCATED' && !value.shared) bucket.allocated = bucket.allocated.plus(value.cost);
}
function targetFromBreakdown(value: CostAllocationTarget): Partial<CostAllocationTarget> { return { ...(value.costCenter === undefined ? {} : { costCenter: value.costCenter }), ...(value.businessUnit === undefined ? {} : { businessUnit: value.businessUnit }), ...(value.project === undefined ? {} : { project: value.project }), ...(value.team === undefined ? {} : { team: value.team }), ...(value.environment === undefined ? {} : { environment: value.environment }) }; }
function targetDimensions(value: CostAllocationTarget): Partial<CostAllocationTarget> { return targetFromBreakdown(value); }
function resourceSet(metric: Metric): Set<string> { return new Set([metric.cloudResourceId ?? metric.resourceId].filter(Boolean)); }
function splitAmounts(cost: Prisma.Decimal, targets: readonly CostAllocationRuleTarget[]): readonly Prisma.Decimal[] {
  let allocated = new Prisma.Decimal(0);
  return targets.map((target, index) => {
    if (index === targets.length - 1) return cost.minus(allocated);
    const amount = cost.mul(new Prisma.Decimal(String(target.percentage))).div(100).toDecimalPlaces(allocationScale, Prisma.Decimal.ROUND_DOWN);
    allocated = allocated.plus(amount);
    return amount;
  });
}

function validateExecutionRules(rules: readonly CostAllocationRule[]): void {
  for (const rule of rules) {
    if (rule.allocationMode !== 'SPLIT') continue;
    if (rule.allocationTargets.length < 2) throw new FinOpsBaseError('La regla SPLIT no tiene suficientes destinos', 'VALIDATION_ERROR');
    let total = new Prisma.Decimal(0);
    const destinations = new Set<string>();
    for (const target of rule.allocationTargets) {
      let percentage: Prisma.Decimal;
      try { percentage = new Prisma.Decimal(String(target.percentage)); } catch { throw new FinOpsBaseError('La regla SPLIT contiene un porcentaje inválido', 'VALIDATION_ERROR'); }
      if (!percentage.isFinite() || percentage.lte(0) || percentage.gt(100) || percentage.toDecimalPlaces(4).eq(percentage) === false) throw new FinOpsBaseError('La regla SPLIT contiene porcentajes inválidos', 'VALIDATION_ERROR');
      const destination = allocationKey(target);
      if (destination === 'UNNAMED' || destinations.has(destination)) throw new FinOpsBaseError('La regla SPLIT contiene destinos duplicados o vacíos', 'VALIDATION_ERROR');
      destinations.add(destination);
      total = total.plus(percentage);
    }
    if (!total.eq(100)) throw new FinOpsBaseError('La regla SPLIT debe sumar exactamente 100 %', 'VALIDATION_ERROR');
  }
}
export function matchesAny(metric: Metric, rules: readonly CostAllocationRule[], period: Date): CostAllocationRule | undefined { return rules.find((rule) => matches(metric, rule, period)); }
export function matches(metric: Metric, rule: CostAllocationRule, _period: Date): boolean { if (rule.effectiveFrom !== undefined && metric.chargePeriodStart < rule.effectiveFrom) return false; if (rule.effectiveTo !== undefined && metric.chargePeriodStart > rule.effectiveTo) return false; const tags = asTags(metric.tags); return (rule.cloudAccountId === undefined || rule.cloudAccountId === metric.cloudAccountId) && (rule.provider === undefined || rule.provider === metric.provider) && (rule.serviceName === undefined || rule.serviceName === metric.serviceName) && (rule.regionId === undefined || rule.regionId === metric.regionId) && (rule.resourceId === undefined || rule.resourceId === metric.resourceId) && (rule.tagKey === undefined || tags[rule.tagKey] === rule.tagValue); }
function asTags(value: unknown): Record<string, string> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}; }
function target(rule: CostAllocationRule): Partial<CostAllocationTarget> { return targetFromBreakdown(rule); }
function allocationKey(value: CostAllocationRule | CostAllocationRuleTarget): string { const values = [value.costCenter, value.businessUnit, value.project, value.team, value.environment].filter((item): item is string => item !== undefined && item !== ''); return values.length === 0 ? ('name' in value ? value.name : 'UNNAMED') : values.join(' · '); }
export function suggestions(metric: Metric): readonly string[] { return ['Crear regla por servicio', 'Crear regla por cuenta cloud', ...(metric.resourceId === '' ? [] : ['Crear regla por recurso']), ...Object.keys(asTags(metric.tags)).map((key) => `Usar etiqueta: ${key}`)].slice(0, 4); }

export function hashMetrics(metrics: readonly Metric[]): string {
  return createHash('sha256').update(metrics.map((metric) => JSON.stringify([
    metric.chargePeriodStart.toISOString(), metric.metricIdentityHash, metric.billingCurrency, metric.billedCost.toString(), metric.cloudAccountId, metric.provider, metric.serviceName, metric.regionId, metric.resourceId, metric.cloudResourceId, metric.resourceLinkReason, Object.entries(asTags(metric.tags)).sort(([left], [right]) => left.localeCompare(right)),
  ])).sort().join('\n')).digest('hex');
}
export function hashRules(rules: readonly CostAllocationRule[]): string { return createHash('sha256').update(rules.map((rule) => JSON.stringify([rule.id, rule.priority, rule.configurationHash ?? rule.id])).join('\n')).digest('hex'); }
export function rulesUsed(metrics: readonly Metric[], rules: readonly CostAllocationRule[], period: Date): readonly CostAllocationRule[] { return rules.filter((rule) => metrics.some((metric) => matches(metric, rule, period))); }
export function toNumber(value: Prisma.Decimal | number): number { return typeof value === 'number' ? value : Number(value.toDecimalPlaces(allocationScale).toString()); }
function round(value: number): number { return Math.round(value * 100) / 100; }
export function filterSummary(summary: readonly AllocationSummary[], allocationKeyValue?: string): readonly AllocationSummary[] {
  if (allocationKeyValue === undefined || allocationKeyValue.trim() === '') return summary;
  const needle = allocationKeyValue.trim().toLowerCase();
  return summary.map((item) => ({ ...item, dimensions: item.dimensions.filter((dimension) => dimension.allocationKey.toLowerCase().includes(needle)) }));
}

export function scalarInput(input: Partial<CostAllocationRuleInput>): Record<string, unknown> { const { allocationTargets: _targets, ...scalar } = input; return Object.fromEntries(Object.entries(scalar).filter(([, value]) => value !== undefined)); }

function line(metric: Metric, allocationAmount: Prisma.Decimal, allocationKeyValue: string, mode: CostAllocationMode, shared: boolean, percentage?: number, ruleId?: string): AllocationLine {
  return { chargePeriodStart: metric.chargePeriodStart, metricIdentityHash: metric.metricIdentityHash, sourceAmount: metric.billedCost, allocationAmount, allocationKey: allocationKeyValue, currency: metric.billingCurrency, allocationMode: mode, shared, ...(percentage === undefined ? {} : { percentage }), ...(ruleId === undefined ? {} : { ruleId }), cloudAccountId: metric.cloudAccountId, provider: metric.provider, serviceName: metric.serviceName, regionId: metric.regionId, resourceId: metric.resourceId, cloudResourceId: metric.cloudResourceId, resourceLinkReason: metric.resourceLinkReason };
}
