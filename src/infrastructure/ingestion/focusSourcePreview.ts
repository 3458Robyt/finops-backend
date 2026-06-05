import type { ProviderCode } from '../../domain/models/CloudConnection.js';
import { optionalString, readBoundedPositiveInteger, readObjectArray, requireString } from './providerConfig.js';

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
        namespaceName: requireString(item['namespaceName'], 'ociFocusReportObjects.namespaceName'),
        bucketName: requireString(item['bucketName'], 'ociFocusReportObjects.bucketName'),
        objectName: requireString(item['objectName'], 'ociFocusReportObjects.objectName'),
        focusVersion: optionalString(item['focusVersion']) ?? '1.0',
      })),
      locations: readObjectArray(metadata, 'ociFocusReportLocations').map((item): OciPreviewLocation => ({
        provider: 'oci',
        namespaceName: requireString(item['namespaceName'], 'ociFocusReportLocations.namespaceName'),
        bucketName: requireString(item['bucketName'], 'ociFocusReportLocations.bucketName'),
        prefix: requireString(item['prefix'], 'ociFocusReportLocations.prefix'),
        focusVersion: optionalString(item['focusVersion']) ?? '1.0',
        maxObjects: readBoundedPositiveInteger(item['maxObjects'], 100, 1, 1000),
      })),
    };
  }

  throw new Error(`Unsupported provider ${provider}`);
}

export function isFocusObjectName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.csv') || lower.endsWith('.csv.gz');
}
