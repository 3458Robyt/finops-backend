import type { IAgentContextRepository } from '../../domain/interfaces/IAgentContextRepository.js';
import type { AiContextOperation } from '../../domain/models/AgentContext.js';

/**
 * Servicio de aplicación encargado de la observabilidad de las operaciones del
 * agente de IA (Context Engine). Su responsabilidad es registrar trazas
 * ("traces") de cada invocación al modelo para auditar qué contexto se usó,
 * qué modelo respondió, su latencia y los identificadores de evidencia
 * involucrados (artefactos, memorias y reglas de tenant).
 *
 * Colaborador inyectado:
 * - {@link IAgentContextRepository}: puerto de persistencia donde se almacenan
 *   las trazas de contexto de IA.
 *
 * Rol dentro del flujo: actúa como capa de telemetría del Context Engine,
 * permitiendo trazar y depurar a posteriori las respuestas generadas por el
 * agente principal.
 */
export class AiObservabilityService {
  constructor(private readonly repository: IAgentContextRepository) {}

  /**
   * Registra una traza de observabilidad de una operación de IA.
   *
   * Las propiedades opcionales solo se incluyen en el registro cuando están
   * definidas, evitando sobrescribir valores con `undefined`. Cuando se aporta
   * `responseText`, su tamaño en tokens se estima y se persiste como
   * `responseTokenEstimate` en lugar del texto completo.
   *
   * Efecto secundario: persiste la traza mediante el repositorio de contexto.
   *
   * @param input - Datos de la traza a registrar.
   * @param input.tenantId - Identificador del tenant propietario de la operación.
   * @param input.userId - Usuario que originó la operación (opcional).
   * @param input.operation - Tipo de operación de contexto de IA ejecutada.
   * @param input.model - Identificador del modelo de IA utilizado.
   * @param input.status - Resultado de la operación: éxito o error.
   * @param input.profileVersion - Versión del perfil TAK activo al momento de la operación (opcional).
   * @param input.promptTokenEstimate - Estimación de tokens del prompt enviado.
   * @param input.responseText - Texto de respuesta del modelo, usado solo para estimar tokens (opcional).
   * @param input.latencyMs - Latencia de la operación en milisegundos (opcional).
   * @param input.artifactIds - Identificadores de artefactos/resúmenes usados como evidencia (opcional).
   * @param input.memoryIds - Identificadores de memorias auditadas usadas (opcional).
   * @param input.tenantRuleIds - Identificadores de reglas de tenant aplicadas (opcional).
   * @param input.conflicts - Conflictos detectados entre reglas de tenant y el perfil global (opcional).
   * @param input.errorMessage - Mensaje de error cuando el estado es 'ERROR' (opcional).
   * @returns Promesa que se resuelve cuando la traza ha sido persistida.
   */
  public async recordTrace(input: {
    readonly tenantId: string;
    readonly userId?: string;
    readonly operation: AiContextOperation;
    readonly model: string;
    readonly status: 'SUCCESS' | 'ERROR';
    readonly profileVersion?: number;
    readonly promptTokenEstimate: number;
    readonly responseText?: string;
    readonly latencyMs?: number;
    readonly artifactIds?: readonly string[];
    readonly memoryIds?: readonly string[];
    readonly tenantRuleIds?: readonly string[];
    readonly conflicts?: readonly string[];
    readonly errorMessage?: string;
  }): Promise<void> {
    await this.repository.createAiContextTrace({
      tenantId: input.tenantId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      operation: input.operation,
      model: input.model,
      status: input.status,
      ...(input.profileVersion !== undefined ? { profileVersion: input.profileVersion } : {}),
      promptTokenEstimate: input.promptTokenEstimate,
      ...(input.responseText !== undefined ? { responseTokenEstimate: this.estimateTokens(input.responseText) } : {}),
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      ...(input.artifactIds !== undefined ? { artifactIds: input.artifactIds } : {}),
      ...(input.memoryIds !== undefined ? { memoryIds: input.memoryIds } : {}),
      ...(input.tenantRuleIds !== undefined ? { tenantRuleIds: input.tenantRuleIds } : {}),
      ...(input.conflicts !== undefined ? { conflicts: input.conflicts } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
    });
  }

  private estimateTokens(value: string): number {
    // Heurística ligera: se asume ~4 caracteres por token (aproximación común
    // para modelos tipo GPT) para estimar el coste sin invocar un tokenizador real.
    return Math.ceil(value.length / 4);
  }
}
