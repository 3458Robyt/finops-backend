import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type { CostAllocationRuleInput, ICostAllocationRepository } from '../../domain/interfaces/ICostAllocationRepository.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import type { CostAllocationMode, CostAllocationRule, CostAllocationRuleStatus, CostAllocationRuleTarget } from '../../domain/models/CostAllocation.js';
import { requirePermission } from '../../domain/security/AuthorizationPolicy.js';
const periodPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

export class CostAllocationService {
  constructor(private readonly repository: ICostAllocationRepository) {}

  public async listRules(actor: AuthContext, status?: CostAllocationRuleStatus): Promise<readonly CostAllocationRule[]> {
    return this.repository.listRules(actor.tenantId, status);
  }

  public async createRule(actor: AuthContext, input: CostAllocationRuleInput): Promise<CostAllocationRule> {
    this.requireManager(actor);
    const prepared = this.prepare(input, 1);
    const rule = await this.repository.createRule(actor.tenantId, actor.userId, prepared);
    await this.repository.writeAudit(actor.tenantId, actor.userId, 'COST_ALLOCATION_RULE_CREATED', rule.id, {
      status: rule.status,
      priority: rule.priority,
      allocationMode: rule.allocationMode,
      configurationHash: rule.configurationHash,
    });
    return rule;
  }

  public async updateRule(actor: AuthContext, ruleId: string, input: Partial<CostAllocationRuleInput>): Promise<CostAllocationRule> {
    this.requireManager(actor);
    const current = await this.requireRule(actor, ruleId);
    const preparedCandidate = this.prepare({ ...toInput(current), ...input }, current.configurationVersion);
    const prepared = {
      ...preparedCandidate,
      configurationVersion: preparedCandidate.configurationHash === current.configurationHash
        ? current.configurationVersion
        : current.configurationVersion + 1,
    };
    const rule = await this.repository.updateRule(actor.tenantId, ruleId, prepared);
    if (rule === null) throw new FinOpsBaseError('Regla de asignación no encontrada o archivada', 'NOT_FOUND');
    await this.repository.writeAudit(actor.tenantId, actor.userId, 'COST_ALLOCATION_RULE_UPDATED', rule.id, {
      status: rule.status,
      priority: rule.priority,
      allocationMode: rule.allocationMode,
      configurationVersion: rule.configurationVersion,
      configurationHash: rule.configurationHash,
    });
    return rule;
  }

  public async activateRule(actor: AuthContext, ruleId: string): Promise<CostAllocationRule> {
    const current = await this.requireRule(actor, ruleId);
    if (current.configurationHash === undefined || current.lastPreviewedHash !== current.configurationHash) throw new FinOpsBaseError('Previsualice la regla antes de activarla', 'VALIDATION_ERROR');
    const rule = await this.updateRule(actor, ruleId, { status: 'ACTIVE' });
    await this.repository.writeAudit(actor.tenantId, actor.userId, 'COST_ALLOCATION_RULE_ACTIVATED', rule.id, { configurationVersion: rule.configurationVersion, configurationHash: rule.configurationHash });
    return rule;
  }

  public async archiveRule(actor: AuthContext, ruleId: string): Promise<CostAllocationRule> {
    this.requireManager(actor);
    const rule = await this.repository.archiveRule(actor.tenantId, ruleId, new Date());
    if (rule === null) throw new FinOpsBaseError('Regla de asignación no encontrada o archivada', 'NOT_FOUND');
    await this.repository.writeAudit(actor.tenantId, actor.userId, 'COST_ALLOCATION_RULE_ARCHIVED', rule.id, {});
    return rule;
  }

  public async preview(actor: AuthContext, input: CostAllocationRuleInput, period: string, ruleId?: string) {
    this.requireManager(actor);
    const prepared = this.prepare(input, input.configurationVersion ?? 1);
    if (ruleId !== undefined) await this.requireRule(actor, ruleId);
    const result = await this.repository.preview(actor.tenantId, prepared, parsePeriod(period), ruleId);
    await this.repository.writeAudit(actor.tenantId, actor.userId, 'COST_ALLOCATION_RULE_PREVIEWED', ruleId ?? `preview:${prepared.configurationHash ?? 'unknown'}`, { period, ruleId, configurationHash: prepared.configurationHash });
    return result;
  }

  public async summary(actor: AuthContext, input: { period: string; cloudAccountId?: string; serviceName?: string; allocationKey?: string }) {
    return this.repository.summarize(actor.tenantId, parsePeriod(input.period), input.cloudAccountId, input.serviceName, input.allocationKey);
  }

  public async comparison(actor: AuthContext, input: { period: string; cloudAccountId?: string; serviceName?: string; allocationKey?: string }) {
    const current = parsePeriod(input.period);
    const previous = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1));
    const [summary, previousSummary] = await Promise.all([
      this.repository.summarize(actor.tenantId, current, input.cloudAccountId, input.serviceName, input.allocationKey),
      this.repository.summarize(actor.tenantId, previous, input.cloudAccountId, input.serviceName, input.allocationKey),
    ]);
    return { summary, previousSummary };
  }

  public async unallocated(actor: AuthContext, input: { period: string; currency?: string; cloudAccountId?: string; serviceName?: string }) {
    return this.repository.unallocated(actor.tenantId, parsePeriod(input.period), input.currency, input.cloudAccountId, input.serviceName);
  }

  public async resourceSummary(actor: AuthContext, resourceId: string, cloudResourceId?: string) {
    return this.repository.resourceSummary(actor.tenantId, resourceId, cloudResourceId);
  }

  public async closePeriod(actor: AuthContext, input: { period: string; confirmUnallocated: boolean; replacementReason?: string }) {
    this.requireManager(actor);
    if (input.confirmUnallocated !== true) throw new FinOpsBaseError('Debe confirmar el tratamiento de los costos sin asignar', 'VALIDATION_ERROR');
    const closures = await this.repository.closePeriod(actor.tenantId, actor.userId, parsePeriod(input.period), true, input.replacementReason);
    await Promise.all(closures.map((closure) => this.repository.writeAudit(actor.tenantId, actor.userId, closure.replacementReason === undefined ? 'COST_ALLOCATION_PERIOD_CLOSED' : 'COST_ALLOCATION_PERIOD_REPLACED', closure.id, {
      period: closure.period,
      currency: closure.currency,
      version: closure.version,
      sourceHash: closure.sourceHash,
      rulesHash: closure.rulesHash,
      confirmUnallocated: true,
      unallocatedTotal: closure.unallocatedTotal,
    })));
    return closures;
  }

  public async listClosures(actor: AuthContext, period?: string) {
    return this.repository.listClosures(actor.tenantId, period === undefined ? undefined : parsePeriod(period));
  }

  public async getClosure(actor: AuthContext, closureId: string) {
    const closure = await this.repository.getClosure(actor.tenantId, closureId);
    if (closure === null) throw new FinOpsBaseError('Cierre de asignación no encontrado', 'NOT_FOUND');
    return closure;
  }

  public async compareClosures(actor: AuthContext, closureId: string) {
    const comparison = await this.repository.compareClosures(actor.tenantId, closureId);
    if (comparison === null) throw new FinOpsBaseError('Cierre de asignación no encontrado', 'NOT_FOUND');
    return comparison;
  }

  private async requireRule(actor: AuthContext, ruleId: string): Promise<CostAllocationRule> {
    const rule = await this.repository.findRule(actor.tenantId, ruleId);
    if (rule === null) throw new FinOpsBaseError('Regla de asignación no encontrada', 'NOT_FOUND');
    return rule;
  }

  private requireManager(actor: AuthContext): void {
    requirePermission(actor.role, 'COST_ALLOCATION_MANAGE', 'No está autorizado para administrar reglas de asignación');
  }

  private prepare(input: CostAllocationRuleInput, configurationVersion: number): CostAllocationRuleInput {
    this.validate(input);
    const allocationMode = input.allocationMode ?? 'DIRECT';
    const allocationTargets = allocationMode === 'SPLIT'
      ? input.allocationTargets ?? []
      : [
          {
            percentage: 100,
            ...(input.costCenter === undefined ? {} : { costCenter: input.costCenter }),
            ...(input.businessUnit === undefined ? {} : { businessUnit: input.businessUnit }),
            ...(input.project === undefined ? {} : { project: input.project }),
            ...(input.team === undefined ? {} : { team: input.team }),
            ...(input.environment === undefined ? {} : { environment: input.environment }),
          },
        ];
    return {
      ...input,
      allocationMode,
      allocationTargets,
      configurationVersion,
      configurationHash: configurationHash({ ...input, allocationMode, allocationTargets }),
    };
  }

  private validate(input: Partial<CostAllocationRuleInput>): void {
    const criteria = [input.cloudAccountId, input.provider, input.serviceName, input.regionId, input.resourceId, input.tagKey];
    const directTargets = [input.costCenter, input.businessUnit, input.project, input.team, input.environment];
    const mode: CostAllocationMode = input.allocationMode ?? 'DIRECT';
    if (criteria.every((value) => value === undefined || value === '')) throw new FinOpsBaseError('Debe indicar al menos un criterio de asignación', 'VALIDATION_ERROR');
    if (mode === 'DIRECT' && directTargets.every((value) => value === undefined || value === '')) throw new FinOpsBaseError('Debe indicar al menos un destino de asignación', 'VALIDATION_ERROR');
    if (mode === 'SPLIT') validateSplitTargets(input.allocationTargets);
    if (input.tagKey !== undefined && (input.tagValue === undefined || input.tagValue === '')) throw new FinOpsBaseError('Debe indicar un valor cuando configura una clave de etiqueta', 'VALIDATION_ERROR');
    if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0)) throw new FinOpsBaseError('La prioridad debe ser un entero no negativo', 'VALIDATION_ERROR');
    if (input.effectiveFrom !== undefined && input.effectiveTo !== undefined && input.effectiveFrom > input.effectiveTo) throw new FinOpsBaseError('El rango de vigencia no es válido', 'VALIDATION_ERROR');
  }
}

function parsePeriod(value: string): Date {
  if (!periodPattern.test(value)) throw new FinOpsBaseError('El período debe tener formato YYYY-MM', 'VALIDATION_ERROR');
  const [year, month] = value.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, 1));
}

function validateSplitTargets(targets: CostAllocationRuleInput['allocationTargets']): void {
  if (targets === undefined || targets.length < 2) throw new FinOpsBaseError('Una regla SPLIT requiere al menos dos destinos', 'VALIDATION_ERROR');
  let total = new Prisma.Decimal(0);
  const keys = new Set<string>();
  for (const target of targets) {
    let percentage: Prisma.Decimal;
    try { percentage = new Prisma.Decimal(String(target.percentage)); } catch { throw new FinOpsBaseError('Los porcentajes de los destinos SPLIT deben ser números válidos', 'VALIDATION_ERROR'); }
    if (!percentage.isFinite() || percentage.lte(0) || percentage.gt(100) || percentage.toDecimalPlaces(4).eq(percentage) === false) throw new FinOpsBaseError('Los porcentajes SPLIT deben ser mayores que 0, no superar 100 y usar máximo 4 decimales', 'VALIDATION_ERROR');
    total = total.plus(percentage);
    const key = [target.costCenter, target.businessUnit, target.project, target.team, target.environment].filter((value): value is string => value !== undefined && value.trim() !== '').join(' · ');
    if (key === '' || keys.has(key)) throw new FinOpsBaseError('Cada destino SPLIT debe ser único', 'VALIDATION_ERROR');
    keys.add(key);
  }
  if (!total.eq(100)) throw new FinOpsBaseError('Los porcentajes SPLIT deben sumar exactamente 100 %', 'VALIDATION_ERROR');
  if (targets.some((target) => [target.costCenter, target.businessUnit, target.project, target.team, target.environment].every((value) => value === undefined || value === ''))) throw new FinOpsBaseError('Cada destino SPLIT debe tener al menos una dimensión de negocio', 'VALIDATION_ERROR');
}

function toInput(rule: CostAllocationRule): CostAllocationRuleInput {
  return {
    name: rule.name,
    priority: rule.priority,
    status: rule.status,
    allocationMode: rule.allocationMode,
    allocationTargets: rule.allocationTargets,
    configurationVersion: rule.configurationVersion,
    ...(rule.description === undefined ? {} : { description: rule.description }),
    ...(rule.cloudAccountId === undefined ? {} : { cloudAccountId: rule.cloudAccountId }),
    ...(rule.provider === undefined ? {} : { provider: rule.provider }),
    ...(rule.serviceName === undefined ? {} : { serviceName: rule.serviceName }),
    ...(rule.regionId === undefined ? {} : { regionId: rule.regionId }),
    ...(rule.resourceId === undefined ? {} : { resourceId: rule.resourceId }),
    ...(rule.tagKey === undefined ? {} : { tagKey: rule.tagKey }),
    ...(rule.tagValue === undefined ? {} : { tagValue: rule.tagValue }),
    ...(rule.costCenter === undefined ? {} : { costCenter: rule.costCenter }),
    ...(rule.businessUnit === undefined ? {} : { businessUnit: rule.businessUnit }),
    ...(rule.project === undefined ? {} : { project: rule.project }),
    ...(rule.team === undefined ? {} : { team: rule.team }),
    ...(rule.environment === undefined ? {} : { environment: rule.environment }),
    ...(rule.effectiveFrom === undefined ? {} : { effectiveFrom: rule.effectiveFrom }),
    ...(rule.effectiveTo === undefined ? {} : { effectiveTo: rule.effectiveTo }),
  };
}

function configurationHash(input: CostAllocationRuleInput & { readonly allocationMode: CostAllocationMode; readonly allocationTargets: readonly CostAllocationRuleTarget[] }): string {
  const canonical = {
    name: input.name,
    description: input.description ?? null,
    priority: input.priority,
    allocationMode: input.allocationMode,
    allocationTargets: input.allocationTargets.map((target) => ({
      percentage: String(target.percentage),
      costCenter: target.costCenter ?? null,
      businessUnit: target.businessUnit ?? null,
      project: target.project ?? null,
      team: target.team ?? null,
      environment: target.environment ?? null,
    })),
    cloudAccountId: input.cloudAccountId ?? null,
    provider: input.provider ?? null,
    serviceName: input.serviceName ?? null,
    regionId: input.regionId ?? null,
    resourceId: input.resourceId ?? null,
    tagKey: input.tagKey ?? null,
    tagValue: input.tagValue ?? null,
    costCenter: input.costCenter ?? null,
    businessUnit: input.businessUnit ?? null,
    project: input.project ?? null,
    team: input.team ?? null,
    environment: input.environment ?? null,
    effectiveFrom: input.effectiveFrom?.toISOString() ?? null,
    effectiveTo: input.effectiveTo?.toISOString() ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
