import type { ProviderCode } from '../../domain/models/CloudConnection.js';
import { readBoundedPositiveInteger } from './providerConfig.js';

export type FocusSourceMode = 'location' | 'object';

export interface ConfigureFocusSourceInput {
  readonly provider: ProviderCode;
  readonly mode: FocusSourceMode;
  readonly values: ReadonlyMap<string, string>;
  readonly existingMetadata: Readonly<Record<string, unknown>>;
  readonly replace: boolean;
}

export interface ConfigureFocusSourceResult {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly updatedKey: string;
  readonly configuredCount: number;
}

export function configureFocusSourceMetadata(input: ConfigureFocusSourceInput): ConfigureFocusSourceResult {
  if (input.provider === 'aws') {
    return configureAwsFocusSource(input);
  }

  if (input.provider === 'oci') {
    return configureOciFocusSource(input);
  }

  throw new Error(`Unsupported provider ${input.provider}`);
}

function configureAwsFocusSource(input: ConfigureFocusSourceInput): ConfigureFocusSourceResult {
  const focusVersion = input.values.get('focus-version') ?? '1.0';
  const region = input.values.get('region');
  const item = input.mode === 'location'
    ? {
        bucket: requireValue(input.values, 'bucket'),
        prefix: requireValue(input.values, 'prefix'),
        focusVersion,
        maxObjects: readMaxObjects(input.values),
        ...(region !== undefined ? { region } : {}),
      }
    : {
        bucket: requireValue(input.values, 'bucket'),
        key: requireValue(input.values, 'key'),
        focusVersion,
        ...(region !== undefined ? { region } : {}),
      };

  return appendMetadataItem({
    existingMetadata: input.existingMetadata,
    key: input.mode === 'location' ? 'awsFocusExportLocations' : 'awsFocusExportObjects',
    item,
    replace: input.replace,
  });
}

function configureOciFocusSource(input: ConfigureFocusSourceInput): ConfigureFocusSourceResult {
  const focusVersion = input.values.get('focus-version') ?? '1.0';
  const item = input.mode === 'location'
    ? {
        namespaceName: requireValue(input.values, 'namespace-name'),
        bucketName: requireValue(input.values, 'bucket-name'),
        prefix: requireValue(input.values, 'prefix'),
        focusVersion,
        maxObjects: readMaxObjects(input.values),
      }
    : {
        namespaceName: requireValue(input.values, 'namespace-name'),
        bucketName: requireValue(input.values, 'bucket-name'),
        objectName: requireValue(input.values, 'object-name'),
        focusVersion,
      };

  return appendMetadataItem({
    existingMetadata: input.existingMetadata,
    key: input.mode === 'location' ? 'ociFocusReportLocations' : 'ociFocusReportObjects',
    item,
    replace: input.replace,
  });
}

function appendMetadataItem(input: {
  readonly existingMetadata: Readonly<Record<string, unknown>>;
  readonly key: string;
  readonly item: Readonly<Record<string, unknown>>;
  readonly replace: boolean;
}): ConfigureFocusSourceResult {
  const current = Array.isArray(input.existingMetadata[input.key])
    ? input.existingMetadata[input.key] as unknown[]
    : [];
  const next = input.replace ? [input.item] : [...current, input.item];

  return {
    metadata: {
      ...input.existingMetadata,
      [input.key]: next,
    },
    updatedKey: input.key,
    configuredCount: next.length,
  };
}

function readMaxObjects(values: ReadonlyMap<string, string>): number {
  return readBoundedPositiveInteger(numberOrUndefined(values.get('max-objects')), 100, 1, 1000);
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requireValue(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required --${key}`);
  }

  return value;
}
