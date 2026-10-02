import type { RecommendationEvidenceSnapshot } from './RecommendationEvidenceSnapshot.js';

export function sourceDiagnosticIssue(
  diagnostic: NonNullable<RecommendationEvidenceSnapshot['sourceDiagnostics']>[number],
): { readonly code: string; readonly action: string } {
  const label = diagnostic.metricName === 'MemoryUtilization' ? 'memoria' : 'CPU';
  if (diagnostic.catalogStatus === 'NOT_DISCOVERED') return {
    code: `${diagnostic.metricName.toUpperCase()}_NOT_DISCOVERED`,
    action: `La serie de ${label} no aparece en el catálogo local. Descubrirla en OCI con región y compartment explícitos; no implica que OCI no la emita.${diagnostic.metricName === 'MemoryUtilization' ? ' Si tampoco aparece en Monitoring, revisar con el administrador el plugin Compute Instance Monitoring, el agente y su conectividad.' : ''}`,
  };
  if (diagnostic.catalogStatus === 'DISABLED') return {
    code: `${diagnostic.metricName.toUpperCase()}_DISABLED`,
    action: `La serie de ${label} fue descubierta pero no está habilitada; confirmar su definición antes de solicitar backfill.`,
  };
  if (diagnostic.latestJobStatus === 'FAILED') return {
    code: 'TECHNICAL_INGESTION_FAILED',
    action: `El último job técnico de la conexión falló. Revisar el error y reintentar solo la serie de ${label} afectada.`,
  };
  return {
    code: `${diagnostic.metricName.toUpperCase()}_NOT_INGESTED`,
    action: `La serie de ${label} está habilitada pero no tiene muestras locales recientes. Consultar OCI; si devuelve datos, encolar backfill dirigido.`,
  };
}

export function technicalBlockerAction(code: string): string {
  if (code === 'MISSING_MEMORY_METRIC') return 'Comprobar emisión de MemoryUtilization en oci_computeagent; el agente OCI y su plugin requieren habilitación y conectividad.';
  if (code === 'MISSING_CPU_METRIC') return 'Descubrir CpuUtilization en oci_computeagent o en el namespace agentless y revisar la ingesta.';
  if (code === 'INSUFFICIENT_TECHNICAL_COVERAGE') return 'Revisar ventanas de cobertura e ingestar únicamente períodos disponibles de las series confirmadas.';
  if (code === 'UNSUPPORTED_RESOURCE_TYPE') return 'Este tipo de recurso requiere una regla de optimización específica; no aplicar rightsizing de Compute.';
  if (code.startsWith('AMBIGUOUS_')) return 'Elegir una serie única por namespace, región y dimensiones antes de analizarla.';
  return 'Revisar los valores, unidad y riesgo técnico antes de recomendar un cambio de capacidad.';
}
