import type { Request } from 'express';
import type { IngestionSourceType } from '../../domain/models/CloudConnection.js';
import type { IngestionMetricCoverageStatus } from '../../domain/interfaces/ICloudConnectionRepository.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';

export type CredentialPurpose =
  | 'OPERATIONAL'
  | 'BILLING_EXPORT_READ'
  | 'INVENTORY_READ'
  | 'METRICS_READ'
  | 'STORAGE_READ';

export type FocusSourceMode = 'location' | 'object';
export type BillingSourceMode = 'AUTO' | 'FOCUS' | 'PROVIDER_API';

/**
 * Validates and normalizes request primitives used by cloud-connection
 * endpoints. Keeping this boundary outside the controller prevents HTTP
 * parsing rules from being mixed with onboarding and ingestion orchestration.
 */
export class CloudConnectionRequestParser {
  public requireTenant(req: Request): string {
    if (req.auth === undefined) {
      throw new FinOpsBaseError('Debes iniciar sesión para continuar.', 'AUTHENTICATION_REQUIRED');
    }

    return req.auth.tenantId;
  }

  public requireParam(req: Request, name: string): string {
    const value = req.params[name];

    if (typeof value !== 'string' || value.trim() === '') {
      throw new FinOpsBaseError(`El parámetro ${name} es obligatorio.`, 'VALIDATION_ERROR');
    }

    return value.trim();
  }

  public requireObjectBody(body: unknown): Record<string, unknown> {
    if (!this.isRecord(body)) {
      throw new FinOpsBaseError('El cuerpo de la solicitud debe ser un objeto JSON.', 'VALIDATION_ERROR');
    }

    return body;
  }

  public requireString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new FinOpsBaseError(`El campo ${fieldName} es obligatorio.`, 'VALIDATION_ERROR');
    }

    return value.trim();
  }

  public parseDate(value: unknown, fieldName: string): Date {
    const raw = this.requireString(value, fieldName);
    const parsed = new Date(raw);

    if (Number.isNaN(parsed.getTime())) {
      throw new FinOpsBaseError(`${fieldName} must be an ISO date`, 'VALIDATION_ERROR');
    }

    return parsed;
  }

  public parseOptionalDate(value: unknown, fieldName: string): Date | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    return this.parseDate(value, fieldName);
  }

  public parseMetricCoverageStatus(value: unknown): IngestionMetricCoverageStatus | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const status = this.requireString(value, 'status') as IngestionMetricCoverageStatus;
    const allowed: readonly IngestionMetricCoverageStatus[] = ['UNKNOWN', 'COVERED', 'PARTIAL', 'NO_DATA', 'FAILED'];
    if (!allowed.includes(status)) {
      throw new FinOpsBaseError('El estado de cobertura no es compatible.', 'VALIDATION_ERROR');
    }
    return status;
  }

  public parseSourceType(value: unknown): IngestionSourceType {
    const sourceType = this.requireString(value, 'sourceType');
    const allowed: readonly IngestionSourceType[] = [
      'BILLING_EXPORT',
      'INVENTORY',
      'TECHNICAL_METRIC',
      'AGENT_METRIC',
    ];

    if (!allowed.includes(sourceType as IngestionSourceType)) {
      throw new FinOpsBaseError('El tipo de fuente de ingesta no es compatible.', 'VALIDATION_ERROR');
    }

    return sourceType as IngestionSourceType;
  }

  public parseCredentialPurpose(value: unknown): CredentialPurpose {
    const purpose = this.requireString(value, 'purpose');
    const allowed: readonly CredentialPurpose[] = [
      'OPERATIONAL',
      'BILLING_EXPORT_READ',
      'INVENTORY_READ',
      'METRICS_READ',
      'STORAGE_READ',
    ];

    if (!allowed.includes(purpose as CredentialPurpose)) {
      throw new FinOpsBaseError(
        'El propósito indicado no corresponde a una credencial de solo lectura compatible.',
        'VALIDATION_ERROR',
      );
    }

    return purpose as CredentialPurpose;
  }

  public parseFocusSourceMode(value: unknown): FocusSourceMode {
    const mode = this.requireString(value, 'mode');
    if (mode !== 'location' && mode !== 'object') {
      throw new FinOpsBaseError('El modo debe ser location u object.', 'VALIDATION_ERROR');
    }

    return mode;
  }

  public parseBillingSourceMode(value: unknown): BillingSourceMode {
    const mode = this.requireString(value, 'mode');
    if (mode !== 'AUTO' && mode !== 'FOCUS' && mode !== 'PROVIDER_API') {
      throw new FinOpsBaseError('El modo debe ser AUTO, FOCUS o PROVIDER_API.', 'VALIDATION_ERROR');
    }

    return mode;
  }

  public requireStringRecord(value: unknown, fieldName: string): Readonly<Record<string, string>> {
    if (!this.isRecord(value)) {
      throw new FinOpsBaseError(`${fieldName} must be an object`, 'VALIDATION_ERROR');
    }

    const entries = Object.entries(value);
    if (entries.length === 0) {
      throw new FinOpsBaseError(`${fieldName} must not be empty`, 'VALIDATION_ERROR');
    }

    return Object.fromEntries(entries.map(([key, item]) => {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new FinOpsBaseError(`${fieldName}.${key} must be a non-empty string`, 'VALIDATION_ERROR');
      }

      return [key, item.trim()];
    }));
  }

  public parseLimit(value: unknown): number | undefined {
    const raw = Array.isArray(value) ? value[0] : value;

    if (typeof raw !== 'string' || raw.trim() === '') {
      return undefined;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  public parseOptionalNumber(value: unknown, fieldName: string): number | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) {
      throw new FinOpsBaseError(`${fieldName} must be a number`, 'VALIDATION_ERROR');
    }

    return parsed;
  }

  public isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}
