import type { ProviderCode } from '../../domain/models/CloudConnection.js';
import { optionalString, readBoundedPositiveInteger, readObjectArray, requireString } from './providerConfig.js';
import { OCI_FOCUS_DEFAULT_MAX_OBJECTS, OCI_FOCUS_MAX_OBJECTS } from './oci/OciFocusSource.js';

export interface AwsPreviewObject {
  readonly provider: 'aws';
  readonly source: 'configured' | 'discovered';
  readonly bucket: string;
  readonly key: string;
  readonly region?: string;
  readonly focusVersion: string;
}

export interface AwsPreviewLocation {
  readonly provider: 'aws';
  readonly bucket: string;
  readonly prefix: string;
  readonly region?: string;
  readonly focusVersion: string;
  readonly maxObjects: number;
}

export interface OciPreviewObject {
  readonly provider: 'oci';
  readonly source: 'configured' | 'discovered';
  readonly namespaceName: string;
  readonly bucketName: string;
  readonly objectName: string;
  readonly focusVersion: string;
}

export interface OciPreviewLocation {
  readonly provider: 'oci';
  readonly namespaceName: string;
  readonly bucketName: string;
  readonly prefix: string;
  readonly focusVersion: string;
  readonly maxObjects: number;
}

export type PreviewObject = AwsPreviewObject | OciPreviewObject;
export type PreviewLocation = AwsPreviewLocation | OciPreviewLocation;

export interface FocusSourcePreviewConfig {
  readonly configuredObjects: readonly PreviewObject[];
  readonly locations: readonly PreviewLocation[];
}

export function readFocusSourcePreviewConfig(
  provider: ProviderCode,
  metadata: Readonly<Record<string, unknown>> | undefined,
): FocusSourcePreviewConfig {
  if (provider === 'aws') {
    return {
      configuredObjects: readObjectArray(metadata, 'awsFocusExportObjects').map((item): AwsPreviewObject => {
        const region = optionalString(item['region']);
        return {
          provider: 'aws',
          source: 'configured',
          bucket: requireString(item['bucket'], 'awsFocusExportObjects.bucket'),
          key: requireString(item['key'], 'awsFocusExportObjects.key'),
          focusVersion: optionalString(item['focusVersion']) ?? '1.0',
          ...(region !== undefined ? { region } : {}),
        };
      }),
      locations: readObjectArray(metadata, 'awsFocusExportLocations').map((item): AwsPreviewLocation => {
        const region = optionalString(item['region']);
        return {
          provider: 'aws',
          bucket: requireString(item['bucket'], 'awsFocusExportLocations.bucket'),
          prefix: requireString(item['prefix'], 'awsFocusExportLocations.prefix'),
          focusVersion: optionalString(item['focusVersion']) ?? '1.0',
          maxObjects: readBoundedPositiveInteger(item['maxObjects'], 100, 1, 1000),
          ...(region !== undefined ? { region } : {}),
        };
      }),
    };
  }

  if (provider === 'oci') {
    return {
      configuredObjects: readObjectArray(metadata, 'ociFocusReportObjects').map((item): OciPreviewObject => ({
        provider: 'oci',
        source: 'configured',
        namespaceName: requireString(readMetadataField(item, 'namespaceName', 'namespace-name'), 'ociFocusReportObjects.namespaceName'),
        bucketName: requireString(readMetadataField(item, 'bucketName', 'bucket-name'), 'ociFocusReportObjects.bucketName'),
        objectName: requireString(readMetadataField(item, 'objectName', 'object-name'), 'ociFocusReportObjects.objectName'),
        focusVersion: optionalString(readMetadataField(item, 'focusVersion', 'focus-version')) ?? '1.0',
      })),
      locations: readObjectArray(metadata, 'ociFocusReportLocations').map((item): OciPreviewLocation => ({
        provider: 'oci',
        namespaceName: requireString(readMetadataField(item, 'namespaceName', 'namespace-name'), 'ociFocusReportLocations.namespaceName'),
        bucketName: requireString(readMetadataField(item, 'bucketName', 'bucket-name'), 'ociFocusReportLocations.bucketName'),
        prefix: requireString(readMetadataField(item, 'prefix'), 'ociFocusReportLocations.prefix'),
        focusVersion: optionalString(readMetadataField(item, 'focusVersion', 'focus-version')) ?? '1.0',
        maxObjects: readBoundedPositiveInteger(
          readMetadataField(item, 'maxObjects', 'max-objects'),
          OCI_FOCUS_DEFAULT_MAX_OBJECTS,
          1,
          OCI_FOCUS_MAX_OBJECTS,
        ),
      })),
    };
  }

  throw new Error(`Unsupported provider ${provider}`);
}

function readMetadataField(
  item: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): unknown {
  for (const key of keys) {
    if (item[key] !== undefined) return item[key];
  }
  return undefined;
}

export function isFocusObjectName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.csv') || lower.endsWith('.csv.gz');
}
