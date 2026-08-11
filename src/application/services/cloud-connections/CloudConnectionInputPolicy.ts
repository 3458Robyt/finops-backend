import type { CloudConnectionSummary } from '../../../domain/models/CloudConnection.js';
import { FinOpsBaseError } from '../../../domain/errors/errors.js';
import { isRecord } from '../cloudConnectionPolicies.js';

export function normalizeOperationalCredential(
  connection: CloudConnectionSummary,
  payload: Readonly<Record<string, unknown>>,
): { readonly payload: Readonly<Record<string, unknown>>; readonly externalPrincipalId: string } {
  if (connection.providerCode === 'aws') {
    const roleArn = requirePayloadString(payload, 'roleArn');
    const externalId = requirePayloadString(payload, 'externalId');
    const region = optionalPayloadString(payload, 'region') ?? connection.defaultRegion ?? 'us-east-1';
    const match = /^arn:aws[a-z-]*:iam::(\d{12}):role\/(.+)$/.exec(roleArn);
    if (match === null) {
      throw new FinOpsBaseError('El Role ARN debe ser un ARN válido de un rol IAM de AWS.', 'VALIDATION_ERROR');
    }
    if (/^\d{12}$/.test(connection.rootExternalId) && match[1] !== connection.rootExternalId) {
      throw new FinOpsBaseError('La cuenta del Role ARN no coincide con el AWS Account ID configurado.', 'VALIDATION_ERROR');
    }

    return {
      payload: { roleArn, externalId, region, sessionName: 'finops-ingestion-worker' },
      externalPrincipalId: roleArn,
    };
  }

  if (connection.providerCode === 'oci') {
    const tenancyId = requirePayloadString(payload, 'tenancyId');
    const userId = requirePayloadString(payload, 'userId');
    const fingerprint = requirePayloadString(payload, 'fingerprint');
    const privateKey = requirePayloadString(payload, 'privateKey');
    const region = optionalPayloadString(payload, 'region') ?? connection.defaultRegion;
    if (tenancyId !== connection.rootExternalId) {
      throw new FinOpsBaseError('El Tenancy OCID de la credencial no coincide con la conexión.', 'VALIDATION_ERROR');
    }
    if (!/^ocid1\.tenancy\./.test(tenancyId) || !/^ocid1\.user\./.test(userId)) {
      throw new FinOpsBaseError('El Tenancy OCID y el User OCID deben ser identificadores OCI válidos.', 'VALIDATION_ERROR');
    }
    if (!/-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(privateKey)) {
      throw new FinOpsBaseError('La clave privada debe estar en formato PEM.', 'VALIDATION_ERROR');
    }
    if (region === undefined) {
      throw new FinOpsBaseError('La región es obligatoria para las credenciales OCI.', 'VALIDATION_ERROR');
    }
    const passphrase = optionalPayloadString(payload, 'passphrase');

    return {
      payload: {
        tenancyId,
        userId,
        fingerprint,
        privateKey,
        region,
        ...(passphrase !== undefined ? { passphrase } : {}),
      },
      externalPrincipalId: userId,
    };
  }

  throw new FinOpsBaseError('El onboarding de credenciales solo está disponible para AWS y OCI.', 'PROVIDER_NOT_ENABLED');
}

function requirePayloadString(payload: Readonly<Record<string, unknown>>, fieldName: string): string {
  const value = payload[fieldName];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new FinOpsBaseError(`El campo ${fieldName} es obligatorio.`, 'VALIDATION_ERROR');
  }

  return value.trim();
}

function optionalPayloadString(
  payload: Readonly<Record<string, unknown>>,
  fieldName: string,
): string | undefined {
  const value = payload[fieldName];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function requireNonEmpty(value: string, fieldName: string): string {
  const normalized = value.trim();

  if (normalized === '') {
    throw new FinOpsBaseError(`El campo ${fieldName} es obligatorio.`, 'VALIDATION_ERROR');
  }

  return normalized;
}

export function normalizeMetricDefinition(
  providerCode: string,
  value: unknown,
  index: number,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new FinOpsBaseError(`definitions[${index}] debe ser un objeto.`, 'VALIDATION_ERROR');
  }
  const text = (field: string): string => requirePayloadString(value, field);
  const optional = (field: string): string | undefined => optionalPayloadString(value, field);
  if (providerCode === 'oci') {
    const query = optional('query');
    const unit = optional('unit');
    return {
      compartmentId: text('compartmentId'),
      namespace: text('namespace'),
      metricName: text('metricName'),
      resourceId: text('resourceId'),
      ...(query !== undefined ? { query } : {}),
      ...(unit !== undefined ? { unit } : {}),
    };
  }
  if (providerCode === 'aws') {
    const dimensions = value['dimensions'];
    if (!Array.isArray(dimensions) || dimensions.length === 0 || dimensions.length > 20) {
      throw new FinOpsBaseError(`definitions[${index}].dimensions debe contener entre 1 y 20 dimensiones.`, 'VALIDATION_ERROR');
    }
    const region = optional('region');
    const unit = optional('unit');
    return {
      externalResourceId: text('externalResourceId'),
      namespace: text('namespace'),
      metricName: text('metricName'),
      stat: text('stat'),
      dimensions: dimensions.map((dimension, dimensionIndex) => {
        if (!isRecord(dimension)) {
          throw new FinOpsBaseError(`definitions[${index}].dimensions[${dimensionIndex}] no es válida.`, 'VALIDATION_ERROR');
        }
        return {
          Name: requirePayloadString(dimension, 'Name'),
          Value: requirePayloadString(dimension, 'Value'),
        };
      }),
      ...(region !== undefined ? { region } : {}),
      ...(unit !== undefined ? { unit } : {}),
    };
  }
  throw new FinOpsBaseError('El proveedor no soporta configuración de métricas.', 'VALIDATION_ERROR');
}
