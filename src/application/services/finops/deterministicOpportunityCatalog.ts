import type { ResourceLinkageReadiness, ResourceLinkageResourceCoverage } from '../../../domain/interfaces/IResourceLinkageReadinessRepository.js';
import {
  deterministicOpportunityRuleVersion,
  type DeterministicFinOpsOpportunity,
  type DeterministicOpportunityCatalog,
  type DeterministicOpportunityEvidence,
  type DeterministicOpportunityKind,
  type DeterministicOpportunityPriority,
  type DeterministicOpportunityStatus,
  type DeterministicOpportunitySignal,
} from '../../../domain/interfaces/deterministicOpportunityModels.js';
import { deterministicBlockerRules } from './deterministicOpportunityRules.js';

const statusPriority: Readonly<Record<DeterministicOpportunityPriority, number>> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3,
};

export function buildDeterministicOpportunityCatalog(
  readiness: ResourceLinkageReadiness,
): DeterministicOpportunityCatalog {
  const opportunities = [
    ...buildBlockerOpportunities(readiness),
    ...buildCoverageOpportunities(readiness),
    ...buildFreshnessOpportunities(readiness),
    ...buildTagOpportunities(readiness),
    ...buildResourceOpportunities(readiness.resources),
  ];
  const unique = new Map(opportunities.map((opportunity) => [opportunity.id, opportunity]));

  return {
    generatedAt: readiness.generatedAt,
    ruleVersion: deterministicOpportunityRuleVersion,
    inventoryResources: readiness.inventoryResources,
    sampledResources: readiness.resources.length,
    resourceCoverageComplete: readiness.resources.length >= readiness.inventoryResources,
    opportunities: [...unique.values()].sort(compareOpportunities),
  };
}

function buildBlockerOpportunities(readiness: ResourceLinkageReadiness): readonly DeterministicFinOpsOpportunity[] {
  return readiness.technicalRecommendationBlockers.flatMap((blocker) => {
    const rule = deterministicBlockerRules[blocker];
    if (rule === undefined) return [];
    return [createOpportunity({
      id: `blocker:${blocker}`,
      ...rule,
      status: 'BLOCKED',
      signals: [{ key: 'blocker', value: blocker }],
    })];
  });
}

function buildCoverageOpportunities(readiness: ResourceLinkageReadiness): readonly DeterministicFinOpsOpportunity[] {
  const sources = [
    { id: 'costs', label: 'costos', coverage: readiness.costs, kind: 'DATA_LINKAGE' as const },
    { id: 'metrics', label: 'métricas técnicas', coverage: readiness.metrics, kind: 'DATA_LINKAGE' as const },
    { id: 'recommendations', label: 'recomendaciones', coverage: readiness.recommendations, kind: 'DATA_LINKAGE' as const },
  ];
  return sources.flatMap(({ id, label, coverage, kind }) => coverage.unresolved <= 0 ? [] : [createOpportunity({
    id: `coverage:${id}:unresolved`, kind, priority: 'HIGH', status: 'OPEN',
    title: `${capitalize(label)} con vínculo pendiente`,
    description: `${coverage.unresolved} registros de ${label} no tienen un vínculo exacto con el inventario normalizado.`,
    action: `Revisar la causa de vínculo y mantener estos registros fuera de la evidencia técnica hasta resolverla.`,
    signals: [
      { key: 'total', value: coverage.total },
      { key: 'eligible', value: coverage.eligible },
      { key: 'unresolved', value: coverage.unresolved },
      { key: 'ambiguous', value: coverage.ambiguous },
    ],
  })]);
}

function buildFreshnessOpportunities(readiness: ResourceLinkageReadiness): readonly DeterministicFinOpsOpportunity[] {
  const sources = [
    { id: 'inventory', label: 'inventario', signal: readiness.freshness.inventory, relevant: readiness.inventoryResources > 0 },
    { id: 'costs', label: 'costos', signal: readiness.freshness.costs, relevant: readiness.costs.total > 0 },
    { id: 'metrics', label: 'métricas técnicas', signal: readiness.freshness.metrics, relevant: readiness.metrics.total > 0 || readiness.inventoryResources > 0 },
  ];
  return sources.flatMap(({ id, label, signal, relevant }) => {
    if (!relevant || signal.status === 'FRESH') return [];
    const priority = signal.status === 'STALE' && id !== 'costs' ? 'HIGH' : 'MEDIUM';
    return [createOpportunity({
      id: `freshness:${id}:${signal.status.toLowerCase()}`,
      kind: 'DATA_FRESHNESS', priority, status: signal.status === 'NO_DATA' ? 'BLOCKED' : 'OPEN',
      title: `${capitalize(label)} sin frescura suficiente`,
      description: signal.status === 'NO_DATA'
        ? `No hay observaciones recientes de ${label} para sustentar una decisión operativa.`
        : `La última observación de ${label} está fuera de la ventana de frescura configurada.`,
      action: `Actualizar ${label} antes de cuantificar o ejecutar una optimización.`,
      signals: [{ key: 'freshnessStatus', value: signal.status }, { key: 'observedAt', value: signal.observedAt?.toISOString() ?? null }],
    })];
  });
}

function buildTagOpportunities(readiness: ResourceLinkageReadiness): readonly DeterministicFinOpsOpportunity[] {
  const missing = Object.entries(readiness.tagGovernance.missingKeys).filter(([, count]) => count > 0);
  if (missing.length === 0 && readiness.tagGovernance.nonCompliantResources === 0) return [];
  if (missing.length === 0) {
    return [createOpportunity({
      id: 'tags:non-compliant-resources', kind: 'TAG_GOVERNANCE', priority: 'MEDIUM', status: 'OPEN',
      title: 'Recursos sin gobierno de etiquetas completo',
      description: `${readiness.tagGovernance.nonCompliantResources} recursos no cumplen las claves obligatorias.`,
      action: 'Completar las etiquetas requeridas para mejorar ownership, entorno y asignación de costos.',
      signals: [{ key: 'nonCompliantResources', value: readiness.tagGovernance.nonCompliantResources }],
    })];
  }
  return missing.map(([key, count]) => createOpportunity({
    id: `tags:missing:${key}`, kind: 'TAG_GOVERNANCE', priority: 'MEDIUM', status: 'OPEN',
    title: `Falta la etiqueta obligatoria ${key}`,
    description: `${count} recursos no tienen la clave de etiqueta ${key}.`,
    action: `Completar ${key} antes de usar el recurso en reportes de ownership o asignación.`,
    signals: [{ key: 'tagKey', value: key }, { key: 'affectedResources', value: count }],
  }));
}

function buildResourceOpportunities(resources: readonly ResourceLinkageResourceCoverage[]): readonly DeterministicFinOpsOpportunity[] {
  return resources.flatMap((resource) => {
    if (resource.evidenceStatus === 'STALE_DATA') return [resourceOpportunity(resource, 'DATA_FRESHNESS', 'HIGH', 'Datos del recurso desactualizados', 'Actualizar costos y métricas del recurso antes de evaluar una acción técnica.')];
    if (resource.evidenceStatus === 'COST_ONLY') return [resourceOpportunity(resource, 'TECHNICAL_EVIDENCE', 'MEDIUM', 'Recurso con evidencia solo financiera', 'Recolectar métricas técnicas; mientras tanto limitar cualquier conclusión a costos y consumo facturado.')];
    if (resource.evidenceStatus === 'TECHNICAL_ONLY') return [resourceOpportunity(resource, 'DATA_LINKAGE', 'MEDIUM', 'Recurso con métricas sin costos enlazados', 'Reconciliar costos por identificador exacto antes de calcular ahorro potencial.')];
    if (resource.evidenceStatus === 'INSUFFICIENT_EVIDENCE') return [resourceOpportunity(resource, 'TECHNICAL_EVIDENCE', 'MEDIUM', 'Recurso sin evidencia suficiente', 'Completar inventario, costos y métricas antes de habilitar una recomendación.')];
    return [];
  });
}

function resourceOpportunity(
  resource: ResourceLinkageResourceCoverage,
  kind: DeterministicOpportunityKind,
  priority: DeterministicOpportunityPriority,
  title: string,
  action: string,
): DeterministicFinOpsOpportunity {
  return createOpportunity({
    id: `resource:${resource.id}:${resource.evidenceStatus}`,
    kind, priority, status: 'OPEN', title,
    description: `El recurso ${resource.externalResourceId} (${resource.serviceName}) está clasificado como ${resource.evidenceStatus}.`,
    action,
    resourceId: resource.id,
    externalResourceId: resource.externalResourceId,
    serviceName: resource.serviceName,
    evidenceStatus: resource.evidenceStatus,
    signals: [
      { key: 'resourceId', value: resource.id },
      { key: 'coverage', value: resource.coverage },
      { key: 'costRecords', value: resource.costMetrics },
      { key: 'metricSamples', value: resource.metricSamples },
      { key: 'evidenceStatus', value: resource.evidenceStatus },
    ],
  });
}

function createOpportunity(input: {
  readonly id: string;
  readonly kind: DeterministicOpportunityKind;
  readonly priority: DeterministicOpportunityPriority;
  readonly status: DeterministicOpportunityStatus;
  readonly title: string;
  readonly description: string;
  readonly action: string;
  readonly resourceId?: string;
  readonly externalResourceId?: string;
  readonly serviceName?: string;
  readonly evidenceStatus?: ResourceLinkageResourceCoverage['evidenceStatus'];
  readonly signals: readonly DeterministicOpportunitySignal[];
}): DeterministicFinOpsOpportunity {
  const evidence: DeterministicOpportunityEvidence = {
    source: 'RESOURCE_LINKAGE_READINESS',
    ruleVersion: deterministicOpportunityRuleVersion,
    signals: input.signals,
  };
  return {
    id: input.id,
    kind: input.kind,
    priority: input.priority,
    status: input.status,
    title: input.title,
    description: input.description,
    recommendedAction: input.action,
    ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
    ...(input.externalResourceId === undefined ? {} : { externalResourceId: input.externalResourceId }),
    ...(input.serviceName === undefined ? {} : { serviceName: input.serviceName }),
    ...(input.evidenceStatus === undefined ? {} : { evidenceStatus: input.evidenceStatus }),
    evidence,
  };
}

function compareOpportunities(left: DeterministicFinOpsOpportunity, right: DeterministicFinOpsOpportunity): number {
  return statusPriority[left.priority] - statusPriority[right.priority] || left.id.localeCompare(right.id);
}

function capitalize(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
