import type { AgentLearningContext } from '../../domain/interfaces/IAgentLearningService.js';

/** Límite por defecto, en caracteres, para el resumen del contexto de aprendizaje. */
const defaultLearningSummaryLimit = 3500;

/**
 * Servicio de aplicación responsable del presupuesto ("budget") de tokens y
 * caracteres del contexto que se entrega al agente de IA. Su objetivo es
 * mantener el contexto dentro de límites manejables para el modelo,
 * compactando el contexto de aprendizaje y truncando textos largos.
 *
 * No tiene colaboradores inyectados de dominio; recibe únicamente el límite
 * máximo de caracteres del resumen de aprendizaje como parámetro de
 * configuración.
 *
 * Rol dentro del flujo: utilizado por el Context Engine para acotar el tamaño
 * del contexto antes de construir el prompt final.
 */
export class ContextBudgeter {
  constructor(private readonly maxLearningSummaryChars = defaultLearningSummaryLimit) {}

  /**
   * Compacta el contexto de aprendizaje del agente para que quepa dentro del
   * presupuesto de caracteres configurado.
   *
   * La lógica normaliza cada línea del resumen (trim), elimina líneas vacías y
   * duplicadas, y luego va acumulando líneas hasta que añadir la siguiente
   * superaría el límite máximo; en ese punto se detiene. Además, recorta las
   * listas de identificadores de memorias y casos a un máximo de 10 elementos
   * para acotar la evidencia referenciada.
   *
   * @param context - Contexto de aprendizaje original con resumen e identificadores.
   * @returns Un nuevo contexto de aprendizaje compactado (resumen recortado y
   *   listas de IDs limitadas a 10), sin mutar el original.
   */
  public compactLearningContext(context: AgentLearningContext): AgentLearningContext {
    const lines = context.summary
      .split('\n')
      .map((line) => line.trim())
      .filter((line, index, all) => line !== '' && all.indexOf(line) === index);

    let summary = '';

    for (const line of lines) {
      const candidate = summary === '' ? line : `${summary}\n${line}`;

      // Se corta en cuanto añadir la siguiente línea excedería el presupuesto,
      // conservando solo las líneas que entran completas.
      if (candidate.length > this.maxLearningSummaryChars) {
        break;
      }

      summary = candidate;
    }

    return {
      memoryIds: context.memoryIds.slice(0, 10),
      caseIds: context.caseIds.slice(0, 10),
      summary,
    };
  }

  /**
   * Trunca un texto a un número máximo de caracteres, colapsando previamente
   * todos los espacios en blanco consecutivos en un único espacio.
   *
   * Cuando el texto normalizado excede el límite, se recorta dejando espacio
   * para los tres puntos suspensivos (`...`) que indican la truncación.
   *
   * @param value - Texto a normalizar y truncar.
   * @param maxChars - Número máximo de caracteres del resultado.
   * @returns El texto normalizado, truncado con sufijo `...` si excedía el límite.
   */
  public truncate(value: string, maxChars: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();

    if (normalized.length <= maxChars) {
      return normalized;
    }

    return `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
  }
}
