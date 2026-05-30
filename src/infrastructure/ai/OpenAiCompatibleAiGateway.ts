import OpenAI from 'openai';
import { ConfigurationError } from '../../domain/errors/errors.js';
import type { AiGatewayRequest, IAiGateway } from '../../domain/interfaces/IAiGateway.js';

/**
 * Adaptador de infraestructura que implementa la interfaz de dominio
 * {@link IAiGateway} sobre un endpoint compatible con la API de OpenAI.
 *
 * Responsabilidad: actuar como puerta de enlace hacia un proveedor de modelos
 * de lenguaje accesible mediante el SDK `openai`. Por defecto apunta al servicio
 * de NVIDIA (NIM / `integrate.api.nvidia.com`), pero el `baseURL`, el modelo y
 * el timeout son configurables por variables de entorno.
 *
 * Configuración por variables de entorno:
 * - `NVIDIA_API_KEY` o `NIM_API_KEY`: clave de API (obligatoria).
 * - `NVIDIA_MODEL`: identificador del modelo (por defecto `deepseek-ai/deepseek-v4-flash`).
 * - `NVIDIA_BASE_URL`: URL base del endpoint compatible con OpenAI.
 * - `NVIDIA_TIMEOUT_MS`: timeout de las peticiones en milisegundos (por defecto 60000).
 */
export class OpenAiCompatibleAiGateway implements IAiGateway {
  private readonly client: OpenAI;
  private readonly model: string;
  /** Nombre del modelo configurado, expuesto públicamente para trazabilidad. */
  public readonly modelName: string;

  /**
   * Inicializa el cliente OpenAI con la clave, URL base y timeout resueltos
   * desde las variables de entorno.
   *
   * @throws {ConfigurationError} Si no se ha configurado `NVIDIA_API_KEY`/`NIM_API_KEY`
   *   o si está vacía.
   */
  constructor() {
    const apiKey = process.env['NVIDIA_API_KEY'] ?? process.env['NIM_API_KEY'];

    if (apiKey === undefined || apiKey.trim() === '') {
      throw new ConfigurationError('NVIDIA_API_KEY must be configured before using AI features');
    }

    this.model = process.env['NVIDIA_MODEL'] ?? 'deepseek-ai/deepseek-v4-flash';
    this.modelName = this.model;
    this.client = new OpenAI({
      apiKey,
      baseURL: process.env['NVIDIA_BASE_URL'] ?? 'https://integrate.api.nvidia.com/v1',
      timeout: this.readTimeoutMs(),
    });
  }

  /**
   * Genera texto a partir de una conversación usando una completación de chat
   * en modo *streaming*, acumulando los fragmentos (`delta.content`) recibidos
   * hasta obtener la respuesta completa.
   *
   * Parámetros de muestreo aplicados:
   * - `temperature`: `request.temperature` o `0.3` por defecto.
   * - `top_p`: `0.95`.
   * - `max_tokens`: `request.maxTokens` o `2048` por defecto.
   * - `stream`: `true` (se consume como iterable asíncrono).
   *
   * @param request - Petición al gateway con los mensajes de la conversación y
   *   parámetros opcionales (`model`, `temperature`, `maxTokens`, `timeoutMs`,
   *   `maxRetries`). El `timeout` y `maxRetries` por petición sobrescriben los
   *   valores del cliente solo cuando están definidos.
   * @returns El texto completo generado por el modelo, concatenando los fragmentos
   *   del stream.
   */
  public async generateText(request: AiGatewayRequest): Promise<string> {
    const completion = await this.client.chat.completions.create({
      model: request.model ?? this.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      temperature: request.temperature ?? 0.3,
      top_p: 0.95,
      max_tokens: request.maxTokens ?? 2048,
      stream: true,
      chat_template_kwargs: {
        thinking: false,
      },
    } as unknown as Parameters<OpenAI['chat']['completions']['create']>[0], {
      ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}),
      ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
    });

    let output = '';
    const stream = completion as AsyncIterable<{
      readonly choices?: ReadonlyArray<{
        readonly delta?: {
          readonly content?: string | null;
        };
      }>;
    }>;

    for await (const chunk of stream) {
      output += chunk.choices?.[0]?.delta?.content ?? '';
    }

    return output;
  }

  /**
   * Lee el timeout de las peticiones (en milisegundos) desde la variable de
   * entorno `NVIDIA_TIMEOUT_MS`.
   *
   * @returns El valor configurado si es un número positivo finito; en caso
   *   contrario, el valor por defecto de 60000 ms.
   */
  private readTimeoutMs(): number {
    const raw = process.env['NVIDIA_TIMEOUT_MS'];

    if (raw === undefined) {
      return 60000;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
  }
}
