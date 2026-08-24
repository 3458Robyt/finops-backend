import type {
  CloudCredentialSummary,
  ICloudConnectionRepository,
} from '../../../domain/interfaces/ICloudConnectionRepository.js';
import type {
  CloudAuthenticationStatus,
  CloudConnectionValidationResult,
  CloudIngestionProvider,
  CloudIngestionConnection,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { FinOpsBaseError } from '../../../domain/errors/errors.js';
import { serializeCapabilityValidation, withTimeout } from '../cloudConnectionPolicies.js';
import type { ValidateCloudCredentialResult } from './CloudConnectionContracts.js';

const OCI_API_KEY_PROPAGATION_GRACE_MS = 5 * 60 * 1000;

export class CloudCredentialValidationService {
  private readonly providers: ReadonlyMap<string, CloudIngestionProvider>;

  constructor(
    private readonly repository: ICloudConnectionRepository,
    providers: readonly CloudIngestionProvider[],
  ) {
    this.providers = new Map(providers.map((provider) => [provider.providerCode, provider]));
  }

  public async validate(
    input: {
      readonly tenantId: string;
      readonly cloudConnectionId: string;
      readonly credential: CloudCredentialSummary;
    },
  ): Promise<ValidateCloudCredentialResult> {
    let candidate: CloudIngestionConnection | null;
    try {
      candidate = await this.repository.getIngestionConnectionForCredential(
        input.tenantId,
        input.cloudConnectionId,
        input.credential.id,
      );
    } catch {
      const retained = await this.repository.updateCredentialValidation(
        input.tenantId,
        input.cloudConnectionId,
        input.credential.id,
        'PENDING',
        'RETRYABLE_ERROR',
        'No se pudo leer la credencial cifrada. La candidata permanece pendiente para reintentar.',
        new Date(),
      );
      if (retained === null) throw new FinOpsBaseError('La credencial candidata ya no está disponible para validación.', 'NOT_FOUND');
      return {
        credential: retained,
        validation: retryableValidation('unknown', 'No se pudo leer la credencial cifrada. Reintenta la validación.', new Date()),
      };
    }
    if (candidate === null) {
      throw new FinOpsBaseError('La credencial candidata ya no está disponible para validación.', 'NOT_FOUND');
    }
    const provider = this.providers.get(candidate.providerCode);
    if (provider === undefined) {
      throw new FinOpsBaseError('No existe un validador para este proveedor cloud.', 'PROVIDER_NOT_ENABLED');
    }

    const checkedAt = new Date();
    let validation: CloudConnectionValidationResult;
    try {
      validation = await withTimeout(
        provider.validate(candidate),
        20_000,
        'La validación cloud superó el tiempo máximo de 20 segundos.',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'El proveedor no respondió durante la validación.';
      const pending = await this.repository.updateCredentialValidation(
        input.tenantId,
        input.cloudConnectionId,
        input.credential.id,
        'PENDING',
        'RETRYABLE_ERROR',
        message,
        checkedAt,
      );
      if (pending === null) throw new FinOpsBaseError('La credencial candidata dejó de existir durante la validación.', 'NOT_FOUND');
      return { credential: pending, validation: retryableValidation(candidate.providerCode, message, checkedAt) };
    }

    let authenticationStatus = resolveAuthenticationStatus(validation);
    if (isFreshOciSignatureRejection(candidate.providerCode, input.credential, authenticationStatus, checkedAt)) {
      authenticationStatus = 'RETRYABLE_ERROR';
      validation = pendingOciPropagationValidation(validation, checkedAt);
    }
    if (authenticationStatus === 'VERIFIED') {
      const promoted = await this.repository.promoteCredential(input.tenantId, input.cloudConnectionId, input.credential.id);
      if (promoted === null) throw new FinOpsBaseError('La credencial candidata no pudo promoverse a activa.', 'CONFLICT');
      const saved = await this.repository.saveConnectionValidation(
        input.tenantId,
        input.cloudConnectionId,
        buildValidationRecord(validation, checkedAt),
        checkedAt,
      );
      if (saved === null) throw new FinOpsBaseError('La conexión dejó de estar disponible durante la validación.', 'NOT_FOUND');
      return { credential: promoted, validation };
    }

    const retained = await this.repository.updateCredentialValidation(
      input.tenantId,
      input.cloudConnectionId,
      input.credential.id,
      authenticationStatus === 'REJECTED' ? 'INVALID' : 'PENDING',
      authenticationStatus,
      validation.authentication?.message ?? firstValidationMessage(validation),
      checkedAt,
    );
    if (retained === null) throw new FinOpsBaseError('La credencial candidata dejó de existir durante la validación.', 'NOT_FOUND');
    return { credential: retained, validation };
  }
}

function isFreshOciSignatureRejection(
  providerCode: string,
  credential: CloudCredentialSummary,
  authenticationStatus: CloudAuthenticationStatus,
  checkedAt: Date,
): boolean {
  const ageMs = checkedAt.getTime() - credential.createdAt.getTime();
  return providerCode === 'oci'
    && authenticationStatus === 'REJECTED'
    && ageMs >= 0
    && ageMs < OCI_API_KEY_PROPAGATION_GRACE_MS;
}

function pendingOciPropagationValidation(
  validation: CloudConnectionValidationResult,
  checkedAt: Date,
): CloudConnectionValidationResult {
  const message = 'OCI todavía puede estar propagando la API key nueva. La credencial quedó guardada y se puede reintentar sin volver a cargar el archivo.';
  return {
    ...validation,
    authentication: {
      status: 'RETRYABLE_ERROR',
      message,
      checkedAt,
      metadata: { reasonCode: 'OCI_API_KEY_PROPAGATION_GRACE' },
    },
  };
}

function resolveAuthenticationStatus(validation: CloudConnectionValidationResult): CloudAuthenticationStatus {
  if (validation.authentication !== undefined) return validation.authentication.status;
  return validation.capabilities.some((item) => item.capability === 'IDENTITY' && item.status === 'AVAILABLE')
    ? 'VERIFIED'
    : 'RETRYABLE_ERROR';
}

function firstValidationMessage(validation: CloudConnectionValidationResult): string {
  return validation.capabilities.find((item) => item.status !== 'AVAILABLE')?.message
    ?? 'El proveedor no pudo confirmar la autenticación.';
}

function buildValidationRecord(
  validation: CloudConnectionValidationResult,
  checkedAt: Date,
): Readonly<Record<string, unknown>> {
  return {
    providerCode: validation.providerCode,
    checkedAt: checkedAt.toISOString(),
    ...(validation.authentication === undefined ? {} : {
      authentication: {
        status: validation.authentication.status,
        message: validation.authentication.message,
        checkedAt: validation.authentication.checkedAt.toISOString(),
        ...(validation.authentication.metadata === undefined ? {} : { metadata: validation.authentication.metadata }),
      },
    }),
    capabilities: validation.capabilities.map(serializeCapabilityValidation),
  };
}

function retryableValidation(
  providerCode: string,
  message: string,
  checkedAt: Date,
): CloudConnectionValidationResult {
  return {
    providerCode,
    authentication: { status: 'RETRYABLE_ERROR', message, checkedAt },
    capabilities: [],
  };
}
