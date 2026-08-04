import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type { CostAllocationRuleInput, ICostAllocationRepository } from '../../domain/interfaces/ICostAllocationRepository.js';
import type { IValueRealizationRepository } from '../../domain/interfaces/IValueRealizationRepository.js';
import type { AllocationBreakdown, AllocationPreview, AllocationSummary, CostAllocationClosure, CostAllocationMode, CostAllocationRule, CostAllocationRuleStatus, CostAllocationRuleTarget, CostAllocationTarget, UnallocatedCostDetail } from '../../domain/models/CostAllocation.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';

type Metric = {
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

type AllocationLine = {
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

const ruleInclude = { allocationTargets: true } as const;
const allocationScale = 6;

export class PrismaCostAllocationRepository implements ICostAllocationRepository {
  constructor(private readonly prisma: PrismaClient, private readonly valueRealization?: Pick<IValueRealizationRepository, 'listDestinationSummary'>) {}

  public async listRules(tenantId: string, status?: CostAllocationRuleStatus): Promise<readonly CostAllocationRule[]> {
    return this.loadRules(this.prisma, tenantId, status);
  }

  public async findRule(tenantId: string, ruleId: string): Promise<CostAllocationRule | null> {
    const row = await this.prisma.costAllocationRule.findFirst({ where: { tenantId, id: ruleId }, include: ruleInclude });
    return row === null ? null : toRule(row);
  }

  public async createRule(tenantId: string, userId: string, input: CostAllocationRuleInput): Promise<CostAllocationRule> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.costAllocationRule.create({ data: { tenantId, createdByUserId: userId, ...scalarInput(input) } as Prisma.CostAllocationRuleUncheckedCreateInput });
      await createTargets(tx, tenantId, row.id, input.allocationTargets);
      const result = await tx.costAllocationRule.findUnique({ where: { id: row.id }, include: ruleInclude });
      if (result === null) throw new FinOpsBaseError('No fue posible recargar la regla de asignación', 'INTERNAL_ERROR');
      return toRule(result);
    });
  }

  public async updateRule(tenantId: string, ruleId: string, input: Partial<CostAllocationRuleInput>): Promise<CostAllocationRule | null> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.costAllocationRule.findFirst({ where: { tenantId, id: ruleId, status: { not: 'ARCHIVED' } }, select: { configurationHash: true } });
      if (current === null) return null;
      const configurationChanged = input.configurationHash !== undefined && input.configurationHash !== current.configurationHash;
      const result = await tx.costAllocationRule.updateMany({ where: { tenantId, id: ruleId, status: { not: 'ARCHIVED' } }, data: { ...scalarInput(input), ...(configurationChanged ? { lastPreviewedHash: null, lastPreviewedAt: null } : {}) } as Prisma.CostAllocationRuleUpdateManyMutationInput });
      if (result.count === 0) return null;
      if (input.allocationTargets !== undefined) {
        await tx.costAllocationRuleTarget.deleteMany({ where: { tenantId, ruleId } });
        await createTargets(tx, tenantId, ruleId, input.allocationTargets);
      }
      const row = await tx.costAllocationRule.findFirst({ where: { tenantId, id: ruleId }, include: ruleInclude });
      return row === null ? null : toRule(row);
    });
  }

  public async archiveRule(tenantId: string, ruleId: string, now: Date): Promise<CostAllocationRule | null> {
    const result = await this.prisma.costAllocationRule.updateMany({ where: { tenantId, id: ruleId, status: { not: 'ARCHIVED' } }, data: { status: 'ARCHIVED', archivedAt: now } });
    return result.count === 0 ? null : this.findRule(tenantId, ruleId);
  }

  public async summarize(tenantId: string, periodStart: Date, cloudAccountId?: string, serviceName?: string, allocationKey?: string): Promise<readonly AllocationSummary[]> {
    const [rules, metrics] = await Promise.all([this.listRules(tenantId, 'ACTIVE'), this.metrics(tenantId, periodStart, cloudAccountId, serviceName)]);
    return filterSummary(allocate(metrics, rules, periodStart).summaries, allocationKey);
  }

  public async preview(tenantId: string, input: CostAllocationRuleInput, periodStart: Date, ruleId?: string): Promise<AllocationPreview> {
    const [metrics, previousMetrics] = await Promise.all([this.metrics(tenantId, periodStart), this.metrics(tenantId, previousMonth(periodStart))]);
    const rule: CostAllocationRule = {
      id: 'preview', tenantId, createdByUserId: 'preview', createdAt: periodStart, updatedAt: periodStart,
      ...input,
      allocationMode: input.allocationMode ?? 'DIRECT', allocationTargets: input.allocationTargets ?? [], configurationVersion: input.configurationVersion ?? 1,
      ...(input.configurationHash === undefined ? {} : { configurationHash: input.configurationHash }),
    } as CostAllocationRule;
    const matchingMetrics = metrics.filter((metric) => matches(metric, rule, periodStart));
    const proposedSummary = summarize(metrics, [rule], periodStart);
    const result = {
      summary: proposedSummary,
      previousSummary: summarize(previousMetrics, [rule], previousMonth(periodStart)),
      rulesUsed: rulesUsed(metrics, [rule], periodStart).map((used) => ({ id: used.id, name: used.name, allocationMode: used.allocationMode, configurationVersion: used.configurationVersion })),
      metricCount: matchingMetrics.length,
      resourceCount: new Set(matchingMetrics.map((metric) => metric.cloudResourceId ?? metric.resourceId).filter(Boolean)).size,
      examples: matchingMetrics.slice(0, 5).map((metric) => ({ currency: metric.billingCurrency, cost: toNumber(metric.billedCost), cloudAccountId: metric.cloudAccountId, serviceName: metric.serviceName, ...(metric.resourceId === '' ? {} : { resourceId: metric.resourceId }) })),
      financialImpact: await this.previewFinancialImpact(tenantId, periodStart, proposedSummary),
    };
    if (ruleId !== undefined && input.configurationHash !== undefined) await this.prisma.costAllocationRule.updateMany({ where: { tenantId, id: ruleId, status: { not: 'ARCHIVED' } }, data: { configurationHash: input.configurationHash, lastPreviewedHash: input.configurationHash, lastPreviewedAt: new Date() } });
    return result;
  }

  private async previewFinancialImpact(tenantId: string, periodStart: Date, summary: readonly AllocationSummary[]) {
    const budgetRowsPromise = 'budget' in this.prisma ? this.prisma.budget.findMany({ where: { tenantId, periodStart, scope: 'ALLOCATION_DESTINATION', status: 'ACTIVE' }, select: { scopeKey: true, currency: true, amount: true } }) : Promise.resolve([]);
    const savingsPromise = this.valueRealization === undefined ? Promise.resolve([]) : this.valueRealization.listDestinationSummary({ tenantId, period: periodStart });
    const [budgetRows, savings] = await Promise.all([budgetRowsPromise, savingsPromise]);
    const budgets = budgetRows.map((row: any) => {
      const projectedCost = summary.find((item) => item.currency === row.currency)?.dimensions.find((dimension) => dimension.allocationKey === row.scopeKey)?.cost ?? 0;
      const budgetAmount = Number(row.amount);
      return { allocationKey: row.scopeKey, currency: row.currency, budgetAmount, projectedCost, remainingBudget: budgetAmount - projectedCost, consumedPercent: budgetAmount === 0 ? 0 : (projectedCost / budgetAmount) * 100 };
    });
    return { budgets, savings };
  }

  public async resourceSummary(tenantId: string, resourceId: string, cloudResourceId?: string): Promise<readonly AllocationSummary[]> {
    const latest = await this.prisma.costMetric.findFirst({ where: { tenantId, ...(cloudResourceId === undefined ? { resourceId } : { cloudResourceId }) }, orderBy: { chargePeriodStart: 'desc' }, select: { chargePeriodStart: true } });
    if (latest === null) return [];
    const periodStart = monthStart(latest.chargePeriodStart);
    const [rules, metrics] = await Promise.all([this.listRules(tenantId, 'ACTIVE'), this.metrics(tenantId, periodStart, undefined, undefined, resourceId, cloudResourceId)]);
    return allocate(metrics, rules, periodStart).summaries;
  }

  public async unallocated(tenantId: string, periodStart: Date, currency?: string, cloudAccountId?: string, serviceName?: string): Promise<readonly UnallocatedCostDetail[]> {
    const [rules, metrics] = await Promise.all([this.listRules(tenantId, 'ACTIVE'), this.metrics(tenantId, periodStart, cloudAccountId, serviceName)]);
    const groups = new Map<string, { readonly currency: string; readonly cost: Prisma.Decimal; readonly metricCount: number; readonly resourceId?: string; readonly cloudResourceId?: string; readonly serviceName: string; readonly cloudAccountId: string; readonly suggestedCriteria: readonly string[] }>();
    for (const metric of metrics) {
      if ((currency !== undefined && metric.billingCurrency !== currency) || matchesAny(metric, rules, periodStart) !== undefined) continue;
      const key = [metric.billingCurrency, metric.cloudAccountId, metric.serviceName, metric.cloudResourceId ?? metric.resourceId].join('|');
      const current = groups.get(key);
      groups.set(key, {
        currency: metric.billingCurrency,
        cost: (current?.cost ?? new Prisma.Decimal(0)).plus(metric.billedCost),
        metricCount: (current?.metricCount ?? 0) + 1,
        ...(metric.resourceId === '' ? {} : { resourceId: metric.resourceId }),
        ...(metric.cloudResourceId === null ? {} : { cloudResourceId: metric.cloudResourceId }),
        serviceName: metric.serviceName,
        cloudAccountId: metric.cloudAccountId,
        suggestedCriteria: current?.suggestedCriteria ?? suggestions(metric),
      });
    }
    return [...groups.values()].map((item) => ({ ...item, cost: toNumber(item.cost) })).sort((a, b) => b.cost - a.cost);
  }

  public async closePeriod(tenantId: string, userId: string, periodStart: Date, _confirmUnallocated: boolean, replacementReason?: string): Promise<readonly CostAllocationClosure[]> {
    const normalizedPeriod = monthStart(periodStart);
    return this.prisma.$transaction(async (tx) => {
      const end = nextMonth(normalizedPeriod);
      const activeJobs = await tx.ingestionJob.count({ where: { tenantId, sourceType: 'BILLING_EXPORT', status: { in: ['PENDING', 'RUNNING'] }, targetStart: { lt: end }, targetEnd: { gt: normalizedPeriod } } });
      if (activeJobs > 0) throw new FinOpsBaseError('El período todavía tiene trabajos de ingesta de facturación activos', 'VALIDATION_ERROR');
      const [rules, metrics] = await Promise.all([this.loadRules(tx, tenantId, 'ACTIVE'), this.metrics(tenantId, normalizedPeriod, undefined, undefined, undefined, undefined, tx)]);
      if (metrics.length === 0) throw new FinOpsBaseError('No hay costos disponibles para este período', 'VALIDATION_ERROR');
      const sourceHashBeforeAllocation = hashMetrics(metrics);
      const allocation = allocate(metrics, rules, normalizedPeriod);
      const sourceHashAfterAllocation = hashMetrics(await this.metrics(tenantId, normalizedPeriod, undefined, undefined, undefined, undefined, tx));
      if (sourceHashBeforeAllocation !== sourceHashAfterAllocation) throw new FinOpsBaseError('La fuente de costos cambió durante el cierre; intente nuevamente', 'VALIDATION_ERROR');
      const summaries = allocation.summaries;
      const rulesHash = hashRules(rules);
      const closures: CostAllocationClosure[] = [];
      for (const summary of summaries) {
        const currencyMetrics = metrics.filter((metric) => metric.billingCurrency === summary.currency);
        const currencySourceHash = hashMetrics(currencyMetrics);
        const existing = await tx.costAllocationClosure.findMany({ where: { tenantId, periodStart: normalizedPeriod, currency: summary.currency }, orderBy: [{ version: 'desc' }] });
        const same = existing.find((closure) => closure.status === 'CLOSED' && closure.sourceHash === currencySourceHash && closure.rulesHash === rulesHash);
        if (same !== undefined) {
          const lineCount = await tx.costAllocationClosureLine.count({ where: { tenantId, closureId: same.id } });
          if (lineCount === 0) await createClosureLines(tx, tenantId, same.id, allocation.lines.filter((line) => line.currency === summary.currency));
          closures.push(toClosure(same));
          continue;
        }
        const current = existing.find((closure) => closure.status === 'CLOSED');
        if (current !== undefined && (replacementReason === undefined || replacementReason.trim() === '')) throw new FinOpsBaseError('El período ya está cerrado; indique el motivo del reemplazo', 'VALIDATION_ERROR');
        if (current !== undefined) await tx.costAllocationClosure.updateMany({ where: { tenantId, periodStart: normalizedPeriod, currency: summary.currency, status: 'CLOSED' }, data: { status: 'REPLACED', replacementReason: replacementReason!.trim() } });
        const version = (existing[0]?.version ?? 0) + 1;
        const created = await tx.costAllocationClosure.create({ data: { tenantId, periodStart: normalizedPeriod, currency: summary.currency, version, status: 'CLOSED', sourceTotal: new Prisma.Decimal(summary.totalCost), allocatedTotal: new Prisma.Decimal(summary.allocatedCost), sharedTotal: new Prisma.Decimal(summary.sharedCost), unallocatedTotal: new Prisma.Decimal(summary.unallocatedCost), sourceHash: currencySourceHash, rulesHash, results: summary.dimensions as unknown as Prisma.InputJsonValue, ...(replacementReason === undefined ? {} : { replacementReason: replacementReason.trim() }), closedByUserId: userId } });
        await createClosureLines(tx, tenantId, created.id, allocation.lines.filter((line) => line.currency === summary.currency));
        closures.push(toClosure(created));
      }
      return closures;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  public async listClosures(tenantId: string, period?: Date): Promise<readonly CostAllocationClosure[]> {
    const rows = await this.prisma.costAllocationClosure.findMany({ where: { tenantId, ...(period === undefined ? {} : { periodStart: period }) }, orderBy: [{ periodStart: 'desc' }, { version: 'desc' }] });
    return rows.map(toClosure);
  }

  public async getClosure(tenantId: string, closureId: string): Promise<CostAllocationClosure | null> {
    const row = await this.prisma.costAllocationClosure.findFirst({ where: { tenantId, id: closureId } });
    return row === null ? null : toClosure(row);
  }

  public async compareClosures(tenantId: string, closureId: string) {
    const current = await this.prisma.costAllocationClosure.findFirst({ where: { tenantId, id: closureId } });
    if (current === null) return null;
    const previous = await this.prisma.costAllocationClosure.findFirst({ where: { tenantId, periodStart: current.periodStart, currency: current.currency, version: { lt: current.version } }, orderBy: { version: 'desc' } });
    return { current: toClosure(current), ...(previous === null ? {} : { previous: toClosure(previous) }) };
  }

  public async writeAudit(tenantId: string, userId: string, action: string, entityId: string, metadata: unknown): Promise<void> {
    await this.prisma.auditEvent.create({ data: { tenantId, actorUserId: userId, action, entityType: 'COST_ALLOCATION', entityId, metadata: metadata as Prisma.InputJsonValue } });
  }

  // ponytail: this evaluates one tenant-month in memory; move first-match ranking to SQL only when measured monthly volume makes it necessary.
  private async loadRules(client: Prisma.TransactionClient | PrismaClient, tenantId: string, status?: CostAllocationRuleStatus): Promise<readonly CostAllocationRule[]> {
    return (await client.costAllocationRule.findMany({ where: { tenantId, ...(status === undefined ? {} : { status }) }, include: ruleInclude, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })).map(toRule);
  }

  private async metrics(tenantId: string, periodStart: Date, cloudAccountId?: string, serviceName?: string, resourceId?: string, cloudResourceId?: string, client: Prisma.TransactionClient | PrismaClient = this.prisma): Promise<readonly Metric[]> {
    const end = nextMonth(periodStart);
    return client.costMetric.findMany({ where: { tenantId, chargePeriodStart: { gte: periodStart, lt: end }, ...(cloudAccountId === undefined ? {} : { cloudAccountId }), ...(serviceName === undefined ? {} : { serviceName }), ...(cloudResourceId === undefined ? (resourceId === undefined ? {} : { resourceId }) : { cloudResourceId }) }, select: { chargePeriodStart: true, metricIdentityHash: true, billedCost: true, billingCurrency: true, cloudAccountId: true, provider: true, serviceName: true, regionId: true, resourceId: true, cloudResourceId: true, resourceLinkReason: true, tags: true } });
  }
}

export function summarize(metrics: readonly Metric[], rules: readonly CostAllocationRule[], periodStart: Date): readonly AllocationSummary[] {
  return allocate(metrics, rules, periodStart).summaries;
}

function allocate(metrics: readonly Metric[], rules: readonly CostAllocationRule[], periodStart: Date): AllocationResult {
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
      addGroup(bucket, { allocationKey: allocationKey(rule), currency: metric.billingCurrency, cost: metric.billedCost, metricCount: 1, resourceCount: resourceSet(metric), shared: false, ruleId: rule.id, ...target(rule) });
      lines.push(line(metric, metric.billedCost, allocationKey(rule), 'DIRECT', false, undefined, rule.id));
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
function matchesAny(metric: Metric, rules: readonly CostAllocationRule[], period: Date): CostAllocationRule | undefined { return rules.find((rule) => matches(metric, rule, period)); }
function matches(metric: Metric, rule: CostAllocationRule, _period: Date): boolean { if (rule.effectiveFrom !== undefined && metric.chargePeriodStart < rule.effectiveFrom) return false; if (rule.effectiveTo !== undefined && metric.chargePeriodStart > rule.effectiveTo) return false; const tags = asTags(metric.tags); return (rule.cloudAccountId === undefined || rule.cloudAccountId === metric.cloudAccountId) && (rule.provider === undefined || rule.provider === metric.provider) && (rule.serviceName === undefined || rule.serviceName === metric.serviceName) && (rule.regionId === undefined || rule.regionId === metric.regionId) && (rule.resourceId === undefined || rule.resourceId === metric.resourceId) && (rule.tagKey === undefined || tags[rule.tagKey] === rule.tagValue); }
function asTags(value: unknown): Record<string, string> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}; }
function target(rule: CostAllocationRule): Partial<CostAllocationTarget> { return targetFromBreakdown(rule); }
function allocationKey(value: CostAllocationRule | CostAllocationRuleTarget): string { const values = [value.costCenter, value.businessUnit, value.project, value.team, value.environment].filter((item): item is string => item !== undefined && item !== ''); return values.length === 0 ? ('name' in value ? value.name : 'UNNAMED') : values.join(' · '); }
function suggestions(metric: Metric): readonly string[] { return ['Crear regla por servicio', 'Crear regla por cuenta cloud', ...(metric.resourceId === '' ? [] : ['Crear regla por recurso']), ...Object.keys(asTags(metric.tags)).map((key) => `Usar etiqueta: ${key}`)].slice(0, 4); }
function scalarInput(input: Partial<CostAllocationRuleInput>): Record<string, unknown> { const { allocationTargets: _targets, ...scalar } = input; return Object.fromEntries(Object.entries(scalar).filter(([, value]) => value !== undefined)); }
async function createTargets(tx: any, tenantId: string, ruleId: string, targets: readonly CostAllocationRuleTarget[] | undefined): Promise<void> { if (targets === undefined || targets.length === 0) return; await tx.costAllocationRuleTarget.createMany({ data: targets.map((target) => ({ tenantId, ruleId, percentage: target.percentage, costCenter: target.costCenter, businessUnit: target.businessUnit, project: target.project, team: target.team, environment: target.environment })) }); }
async function createClosureLines(tx: any, tenantId: string, closureId: string, lines: readonly AllocationLine[]): Promise<void> {
  if (lines.length === 0) return;
  await tx.costAllocationClosureLine.createMany({ data: lines.map((item) => ({ id: lineId(closureId, item), tenantId, closureId, chargePeriodStart: item.chargePeriodStart, metricIdentityHash: item.metricIdentityHash, currency: item.currency, sourceAmount: item.sourceAmount, allocationAmount: item.allocationAmount, allocationKey: item.allocationKey, allocationMode: item.allocationMode, shared: item.shared, ...(item.percentage === undefined ? {} : { percentage: item.percentage }), ...(item.ruleId === undefined ? {} : { ruleId: item.ruleId }), cloudAccountId: item.cloudAccountId, provider: item.provider, serviceName: item.serviceName, ...(item.regionId === null ? {} : { regionId: item.regionId }), ...(item.resourceId === '' ? {} : { resourceId: item.resourceId }), ...(item.cloudResourceId === null ? {} : { cloudResourceId: item.cloudResourceId }), ...(item.resourceLinkReason === null ? {} : { resourceLinkReason: item.resourceLinkReason }) })) });
}
function line(metric: Metric, allocationAmount: Prisma.Decimal, allocationKeyValue: string, mode: CostAllocationMode, shared: boolean, percentage?: number, ruleId?: string): AllocationLine { return { chargePeriodStart: metric.chargePeriodStart, metricIdentityHash: metric.metricIdentityHash, sourceAmount: metric.billedCost, allocationAmount, allocationKey: allocationKeyValue, currency: metric.billingCurrency, allocationMode: mode, shared, ...(percentage === undefined ? {} : { percentage }), ...(ruleId === undefined ? {} : { ruleId }), cloudAccountId: metric.cloudAccountId, provider: metric.provider, serviceName: metric.serviceName, regionId: metric.regionId, resourceId: metric.resourceId, cloudResourceId: metric.cloudResourceId, resourceLinkReason: metric.resourceLinkReason }; }
function lineId(closureId: string, item: AllocationLine): string { return createHash('sha256').update([closureId, item.chargePeriodStart.toISOString(), item.metricIdentityHash, item.allocationKey].join('|')).digest('hex'); }
function filterSummary(summary: readonly AllocationSummary[], allocationKey?: string): readonly AllocationSummary[] {
  if (allocationKey === undefined || allocationKey.trim() === '') return summary;
  const needle = allocationKey.trim().toLowerCase();
  return summary.map((item) => ({ ...item, dimensions: item.dimensions.filter((dimension) => dimension.allocationKey.toLowerCase().includes(needle)) }));
}
function toRule(row: any): CostAllocationRule { return { ...row, allocationMode: row.allocationMode ?? 'DIRECT', allocationTargets: (row.allocationTargets ?? []).map((targetRow: any) => ({ id: targetRow.id, percentage: Number(targetRow.percentage), costCenter: targetRow.costCenter ?? undefined, businessUnit: targetRow.businessUnit ?? undefined, project: targetRow.project ?? undefined, team: targetRow.team ?? undefined, environment: targetRow.environment ?? undefined })), configurationVersion: row.configurationVersion ?? 1, configurationHash: row.configurationHash ?? undefined, lastPreviewedHash: row.lastPreviewedHash ?? undefined, lastPreviewedAt: row.lastPreviewedAt ?? undefined, description: row.description ?? undefined, cloudAccountId: row.cloudAccountId ?? undefined, provider: row.provider ?? undefined, serviceName: row.serviceName ?? undefined, regionId: row.regionId ?? undefined, resourceId: row.resourceId ?? undefined, tagKey: row.tagKey ?? undefined, tagValue: row.tagValue ?? undefined, costCenter: row.costCenter ?? undefined, businessUnit: row.businessUnit ?? undefined, project: row.project ?? undefined, team: row.team ?? undefined, environment: row.environment ?? undefined, effectiveFrom: row.effectiveFrom ?? undefined, effectiveTo: row.effectiveTo ?? undefined, archivedAt: row.archivedAt ?? undefined }; }
function toClosure(row: any): CostAllocationClosure { const results = Array.isArray(row.results) ? row.results : []; return { id: row.id, tenantId: row.tenantId, period: row.periodStart.toISOString().slice(0, 7), currency: row.currency, version: row.version, status: row.status, sourceTotal: toNumber(row.sourceTotal), allocatedTotal: toNumber(row.allocatedTotal), sharedTotal: toNumber(row.sharedTotal), unallocatedTotal: toNumber(row.unallocatedTotal), sourceHash: row.sourceHash, rulesHash: row.rulesHash, results: results as CostAllocationClosure['results'], replacementReason: row.replacementReason ?? undefined, closedByUserId: row.closedByUserId, createdAt: row.createdAt }; }
function nextMonth(value: Date): Date { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1)); }
function monthStart(value: Date): Date { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1)); }
function previousMonth(value: Date): Date { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() - 1, 1)); }
function hashMetrics(metrics: readonly Metric[]): string {
  return createHash('sha256').update(metrics.map((metric) => JSON.stringify([
    metric.chargePeriodStart.toISOString(),
    metric.metricIdentityHash,
    metric.billingCurrency,
    metric.billedCost.toString(),
    metric.cloudAccountId,
    metric.provider,
    metric.serviceName,
    metric.regionId,
    metric.resourceId,
    metric.cloudResourceId,
    metric.resourceLinkReason,
    Object.entries(asTags(metric.tags)).sort(([left], [right]) => left.localeCompare(right)),
  ])).sort().join('\n')).digest('hex');
}
function hashRules(rules: readonly CostAllocationRule[]): string { return createHash('sha256').update(rules.map((rule) => JSON.stringify([rule.id, rule.priority, rule.configurationHash ?? rule.id])).join('\n')).digest('hex'); }
function rulesUsed(metrics: readonly Metric[], rules: readonly CostAllocationRule[], period: Date): readonly CostAllocationRule[] { return rules.filter((rule) => metrics.some((metric) => matches(metric, rule, period))); }
function toNumber(value: Prisma.Decimal | number): number { return typeof value === 'number' ? value : Number(value.toDecimalPlaces(allocationScale).toString()); }
function round(value: number): number { return Math.round(value * 100) / 100; }
