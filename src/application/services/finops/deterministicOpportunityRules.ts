import type {
  DeterministicOpportunityKind,
  DeterministicOpportunityPriority,
} from '../../../domain/interfaces/deterministicOpportunityModels.js';

export interface DeterministicBlockerRule {
  readonly kind: DeterministicOpportunityKind;
  readonly priority: DeterministicOpportunityPriority;
  readonly title: string;
  readonly description: string;
  readonly action: string;
}

export const deterministicBlockerRules: Readonly<Record<string, DeterministicBlockerRule>> = {
  NO_NORMALIZED_INVENTORY: {
    kind: 'DATA_LINKAGE', priority: 'CRITICAL', title: 'Inventario normalizado ausente',
    description: 'Hay datos enlazables, pero no existe inventario canónico suficiente para cruzarlos con recursos.',
    action: 'Ejecutar o corregir la ingesta de inventario antes de generar oportunidades técnicas.',
  },
  NO_RESOURCE_WITH_COST_AND_TECHNICAL_EVIDENCE: {
    kind: 'TECHNICAL_EVIDENCE', priority: 'HIGH', title: 'Falta evidencia técnica cruzada',
    description: 'No hay ningún recurso con costos y métricas técnicas enlazados simultáneamente.',
    action: 'Completar el inventario y la ingesta de métricas antes de sugerir cambios de capacidad.',
  },
  UNLINKED_COST_EVIDENCE: {
    kind: 'DATA_LINKAGE', priority: 'HIGH', title: 'Costos pendientes de vinculación',
    description: 'Existen costos elegibles cuyo identificador no coincide de forma exacta con el inventario.',
    action: 'Revisar identificadores, conexión cloud y cobertura del inventario; no usar esos costos como evidencia técnica.',
  },
  UNLINKED_TECHNICAL_EVIDENCE: {
    kind: 'DATA_LINKAGE', priority: 'HIGH', title: 'Métricas pendientes de vinculación',
    description: 'Existen muestras técnicas sin un recurso normalizado asociado.',
    action: 'Corregir el vínculo exacto de las métricas antes de usarlas para una recomendación.',
  },
  INVENTORY_NOT_FRESH: {
    kind: 'DATA_FRESHNESS', priority: 'HIGH', title: 'Inventario desactualizado',
    description: 'La última observación del inventario supera la ventana de frescura definida.',
    action: 'Actualizar el inventario y volver a evaluar la evidencia de los recursos.',
  },
  COST_DATA_NOT_FRESH: {
    kind: 'DATA_FRESHNESS', priority: 'MEDIUM', title: 'Costos desactualizados',
    description: 'Los costos disponibles pueden no representar el periodo operativo actual.',
    action: 'Ejecutar una ingesta de costos antes de cuantificar ahorros nuevos.',
  },
  TECHNICAL_METRICS_NOT_FRESH: {
    kind: 'DATA_FRESHNESS', priority: 'HIGH', title: 'Métricas técnicas desactualizadas',
    description: 'Las métricas técnicas están fuera de la ventana de frescura definida.',
    action: 'Actualizar las métricas antes de recomendar resize, apagado o cambios de capacidad.',
  },
};
