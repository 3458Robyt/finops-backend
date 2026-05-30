/**
 * ═══════════════════════════════════════════════════════════════
 * Errores del Dominio — Barrel Export
 * ═══════════════════════════════════════════════════════════════
 *
 * Reexporta la jerarquía de errores del dominio definida en `errors.ts`,
 * permitiendo importarlos desde `domain/errors`. Solo reexporta; no contiene lógica.
 */
export {
  FinOpsBaseError,
  AuthenticationError,
  AuthorizationError,
  ConfigurationError,
  ProviderError,
  ProviderNotFoundError,
  IngestionError,
} from './errors.js';
