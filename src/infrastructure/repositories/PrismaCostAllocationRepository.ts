import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type { CostAllocationRuleInput, ICostAllocationRepository } from '../../domain/interfaces/ICostAllocationRepository.js';
import type { IValueRealizationRepository } from '../../domain/interfaces/IValueRealizationRepository.js';
import type { AllocationBreakdown, AllocationPreview, AllocationSummary, CostAllocationClosure, CostAllocationMode, CostAllocationRule, CostAllocationRuleStatus, CostAllocationRuleTarget, CostAllocationTarget, UnallocatedCostDetail } from '../../domain/models/CostAllocation.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';
import { allocate, filterSummary, hashMetrics, hashRules, matches, matchesAny, rulesUsed, suggestions, summarize, toNumber, scalarInput } from './costAllocationEngine.js';
import type { AllocationLine, Metric } from './costAllocationEngine.js';

export { summarize } from './costAllocationEngine.js';

const ruleInclude = { allocationTargets: true } as const;
const bulkClosureLineThreshold = 500;

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
      const sourceTotalBeforeAllocation = metrics.reduce((total, metric) => total.plus(metric.billedCost), new Prisma.Decimal(0));
      const allocation = allocate(metrics, rules, normalizedPeriod);
      const sourceStateAfterAllocation = await tx.costMetric.aggregate({
        where: { tenantId, chargePeriodStart: { gte: normalizedPeriod, lt: end } },
        _count: { _all: true },
        _sum: { billedCost: true },
      });
      const sourceTotalAfterAllocation = sourceStateAfterAllocation._sum.billedCost ?? new Prisma.Decimal(0);
      const sourceMetricsAfterAllocation = sourceStateAfterAllocation._count._all === metrics.length && sourceTotalBeforeAllocation.eq(sourceTotalAfterAllocation)
        ? await this.metrics(tenantId, normalizedPeriod, undefined, undefined, undefined, undefined, tx)
        : [];
      if (sourceStateAfterAllocation._count._all !== metrics.length || !sourceTotalBeforeAllocation.eq(sourceTotalAfterAllocation) || hashMetrics(sourceMetricsAfterAllocation) !== sourceHashBeforeAllocation) throw new FinOpsBaseError('La fuente de costos cambió durante el cierre; intente nuevamente', 'VALIDATION_ERROR');
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
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 120_000 });
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

async function createTargets(tx: any, tenantId: string, ruleId: string, targets: readonly CostAllocationRuleTarget[] | undefined): Promise<void> {
  if (targets === undefined || targets.length === 0) return;
  await tx.costAllocationRuleTarget.createMany({ data: targets.map((target) => ({ tenantId, ruleId, percentage: target.percentage, costCenter: target.costCenter, businessUnit: target.businessUnit, project: target.project, team: target.team, environment: target.environment })) });
}

async function createClosureLines(tx: any, tenantId: string, closureId: string, lines: readonly AllocationLine[]): Promise<void> {
  if (lines.length === 0) return;
  const data = lines.map((item) => ({ id: lineId(closureId, item), tenantId, closureId, chargePeriodStart: item.chargePeriodStart, metricIdentityHash: item.metricIdentityHash, currency: item.currency, sourceAmount: item.sourceAmount, allocationAmount: item.allocationAmount, allocationKey: item.allocationKey, allocationMode: item.allocationMode, shared: item.shared, ...(item.percentage === undefined ? {} : { percentage: item.percentage }), ...(item.ruleId === undefined ? {} : { ruleId: item.ruleId }), cloudAccountId: item.cloudAccountId, provider: item.provider, serviceName: item.serviceName, ...(item.regionId === null ? {} : { regionId: item.regionId }), ...(item.resourceId === '' ? {} : { resourceId: item.resourceId }), ...(item.cloudResourceId === null ? {} : { cloudResourceId: item.cloudResourceId }), ...(item.resourceLinkReason === null ? {} : { resourceLinkReason: item.resourceLinkReason }) }));
  if (lines.length <= bulkClosureLineThreshold) {
    await tx.costAllocationClosureLine.createMany({ data });
    return;
  }
  const payload = JSON.stringify(data.map((item) => ({
    id: item.id, tenant_id: item.tenantId, closure_id: item.closureId, charge_period_start: item.chargePeriodStart.toISOString(), metric_identity_hash: item.metricIdentityHash, currency: item.currency, source_amount: item.sourceAmount.toString(), allocation_amount: item.allocationAmount.toString(), allocation_key: item.allocationKey, allocation_mode: item.allocationMode, shared: item.shared, percentage: item.percentage ?? null, rule_id: item.ruleId ?? null, cloud_account_id: item.cloudAccountId, provider: item.provider, service_name: item.serviceName, region_id: item.regionId, resource_id: item.resourceId === '' ? null : item.resourceId, cloud_resource_id: item.cloudResourceId, resource_link_reason: item.resourceLinkReason,
  })));
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "cost_allocation_closure_lines" (
      "id", "tenant_id", "closure_id", "charge_period_start", "metric_identity_hash", "currency",
      "source_amount", "allocation_amount", "allocation_key", "allocation_mode", "shared", "percentage",
      "rule_id", "cloud_account_id", "provider", "service_name", "region_id", "resource_id",
      "cloud_resource_id", "resource_link_reason"
    )
    SELECT item.id, item.tenant_id, item.closure_id, item.charge_period_start, item.metric_identity_hash, item.currency,
      item.source_amount, item.allocation_amount, item.allocation_key, item.allocation_mode::"CostAllocationMode",
      item.shared, item.percentage, item.rule_id, item.cloud_account_id, item.provider::"CloudProvider", item.service_name,
      item.region_id, item.resource_id, item.cloud_resource_id, item.resource_link_reason
    FROM jsonb_to_recordset(CAST(${payload} AS jsonb)) AS item(
      id text, tenant_id text, closure_id text, charge_period_start timestamptz, metric_identity_hash text,
      currency text, source_amount numeric, allocation_amount numeric, allocation_key text, allocation_mode text,
      shared boolean, percentage numeric, rule_id text, cloud_account_id text, provider text, service_name text,
      region_id text, resource_id text, cloud_resource_id text, resource_link_reason text
    )
    ON CONFLICT ("id") DO NOTHING
  `);
}

function lineId(closureId: string, item: AllocationLine): string {
  return createHash('sha256').update([closureId, item.chargePeriodStart.toISOString(), item.metricIdentityHash, item.allocationKey].join('|')).digest('hex');
}

function toRule(row: any): CostAllocationRule {
  return { ...row, allocationMode: row.allocationMode ?? 'DIRECT', allocationTargets: (row.allocationTargets ?? []).map((targetRow: any) => ({ id: targetRow.id, percentage: Number(targetRow.percentage), costCenter: targetRow.costCenter ?? undefined, businessUnit: targetRow.businessUnit ?? undefined, project: targetRow.project ?? undefined, team: targetRow.team ?? undefined, environment: targetRow.environment ?? undefined })), configurationVersion: row.configurationVersion ?? 1, configurationHash: row.configurationHash ?? undefined, lastPreviewedHash: row.lastPreviewedHash ?? undefined, lastPreviewedAt: row.lastPreviewedAt ?? undefined, description: row.description ?? undefined, cloudAccountId: row.cloudAccountId ?? undefined, provider: row.provider ?? undefined, serviceName: row.serviceName ?? undefined, regionId: row.regionId ?? undefined, resourceId: row.resourceId ?? undefined, tagKey: row.tagKey ?? undefined, tagValue: row.tagValue ?? undefined, costCenter: row.costCenter ?? undefined, businessUnit: row.businessUnit ?? undefined, project: row.project ?? undefined, team: row.team ?? undefined, environment: row.environment ?? undefined, effectiveFrom: row.effectiveFrom ?? undefined, effectiveTo: row.effectiveTo ?? undefined, archivedAt: row.archivedAt ?? undefined };
}

function toClosure(row: any): CostAllocationClosure {
  const results = Array.isArray(row.results) ? row.results : [];
  return { id: row.id, tenantId: row.tenantId, period: row.periodStart.toISOString().slice(0, 7), currency: row.currency, version: row.version, status: row.status, sourceTotal: toNumber(row.sourceTotal), allocatedTotal: toNumber(row.allocatedTotal), sharedTotal: toNumber(row.sharedTotal), unallocatedTotal: toNumber(row.unallocatedTotal), sourceHash: row.sourceHash, rulesHash: row.rulesHash, results: results as CostAllocationClosure['results'], replacementReason: row.replacementReason ?? undefined, closedByUserId: row.closedByUserId, createdAt: row.createdAt };
}

function nextMonth(value: Date): Date { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1)); }
function monthStart(value: Date): Date { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1)); }
function previousMonth(value: Date): Date { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() - 1, 1)); }
