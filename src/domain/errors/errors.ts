/**
 * ═══════════════════════════════════════════════════════════════
 * Custom Errors — Manejo de Errores Centralizado
 * ═══════════════════════════════════════════════════════════════
 *
 * Jerarquía de errores personalizados para el sistema FinOps.
 * Permite un manejo de errores estructurado y granular a través
 * de Try/Catch en todas las capas de la arquitectura.
 *
 * @module domain/errors
 */

/**
 * Error base del dominio FinOps.
 * Todos los errores personalizados extienden de esta clase.
 */
export class FinOpsBaseError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;

  constructor(message: string, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.timestamp = new Date();

    // Restaurar la cadena de prototipos (necesario en TypeScript para herencia de Error)
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error lanzado cuando un proveedor de nube falla durante
 * la extracción o transformación de datos de costos.
 */
export class ProviderError extends FinOpsBaseError {
  public readonly providerName: string;

  constructor(providerName: string, message: string, public readonly cause?: Error) {
    super(
      `[${providerName}] Provider Error: ${message}`,
      'PROVIDER_ERROR',
    );
    this.providerName = providerName;
  }
}

/**
 * Error lanzado cuando se solicita un proveedor que no está
 * registrado en el sistema.
 */
export class ProviderNotFoundError extends FinOpsBaseError {
  public readonly providerName: string;

  constructor(providerName: string) {
    super(
      `Provider "${providerName}" is not registered. Available providers must be injected at startup.`,
      'PROVIDER_NOT_FOUND',
    );
    this.providerName = providerName;
  }
}

/**
 * Error lanzado cuando el proceso de ingesta de datos falla
 * en la capa de orquestación.
 */
export class IngestionError extends FinOpsBaseError {
  public readonly providerName: string;
  public readonly accountId: string;

  constructor(
    providerName: string,
    accountId: string,
    message: string,
    public readonly cause?: Error,
  ) {
    super(
      `[Ingestion] Provider: ${providerName}, Account: ${accountId} — ${message}`,
      'INGESTION_ERROR',
    );
    this.providerName = providerName;
    this.accountId = accountId;
  }
}
