/**
 * Rol de un mensaje dentro de una conversación con el modelo de IA.
 *
 * - `system`: instrucciones de comportamiento o contexto base.
 * - `user`: entrada del usuario o de la aplicación.
 * - `assistant`: respuesta previa generada por el modelo.
 */
export type AiMessageRole = 'system' | 'user' | 'assistant';

/**
 * Mensaje individual que forma parte de la solicitud al modelo de IA.
 */
export interface AiGatewayMessage {
  /** Rol del emisor del mensaje en la conversación. */
  readonly role: AiMessageRole;
  /** Contenido textual del mensaje. */
  readonly content: string;
}

/**
 * Parámetros de una solicitud de generación de texto al gateway de IA.
 */
export interface AiGatewayRequest {
  /** Secuencia de mensajes que componen el prompt de la conversación. */
  readonly messages: readonly AiGatewayMessage[];
  /** Grado de aleatoriedad de la generación (típicamente 0–2); valores bajos producen salidas más deterministas. */
  readonly temperature?: number;
  /** Límite máximo de tokens a generar en la respuesta. */
  readonly maxTokens?: number;
  /** Tiempo máximo de espera en milisegundos antes de abortar la solicitud. */
  readonly timeoutMs?: number;
  /** Número máximo de reintentos ante fallos transitorios. */
  readonly maxRetries?: number;
  /** Formato esperado de la respuesta: texto libre o JSON estructurado. */
  readonly responseFormat?: 'text' | 'json';
  /** Modelo específico a utilizar; si se omite, se usa el modelo por defecto del gateway. */
  readonly model?: string;
}

/**
 * Contrato del gateway hacia un proveedor de modelos de IA.
 *
 * Puerto de dominio (DIP) que abstrae la comunicación con un proveedor de LLM.
 * La implementación concreta (OpenAI, Gemini, etc.) reside en la capa de
 * infraestructura, permitiendo intercambiar proveedores sin afectar la lógica de negocio.
 */
export interface IAiGateway {
  /** Nombre del modelo activo en esta instancia del gateway; opcional según la implementación. */
  readonly modelName?: string;

  /**
   * Genera texto a partir de la solicitud proporcionada.
   *
   * @param request - Mensajes y parámetros de generación.
   * @returns El texto generado por el modelo.
   */
  generateText(request: AiGatewayRequest): Promise<string>;
}
