import type {
  NormalizedCloudResource,
  NormalizedResourceMetricSample,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import { normalizeExternalResourceId } from '../../domain/models/ResourceLinkage.js';

export interface MetricResourceContext {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly defaultRegion?: string;
}

export function buildMetricDerivedResources(
  context: MetricResourceContext,
  samples: readonly NormalizedResourceMetricSample[],
): readonly NormalizedCloudResource[] {
  const byExternalResourceId = new Map<string, {
    readonly sample: NormalizedResourceMetricSample;
    readonly metricNames: Set<string>;
    sampleCount: number;
  }>();

  for (const sample of samples) {
    const externalResourceId = normalizeExternalResourceId(sample.externalResourceId);
    if (externalResourceId === undefined) {
      continue;
    }

    const normalizedSample = externalResourceId === sample.externalResourceId
      ? sample
      : { ...sample, externalResourceId };
    const current = byExternalResourceId.get(externalResourceId);
    if (current === undefined) {
      byExternalResourceId.set(externalResourceId, {
        sample: normalizedSample,
        metricNames: new Set([normalizedSample.metricName]),
        sampleCount: 1,
      });
      continue;
    }

    current.metricNames.add(normalizedSample.metricName);
    current.sampleCount += 1;
  }

  return [...byExternalResourceId.values()].map(({ sample, metricNames, sampleCount }) => {
    const regionId = readRawMetricString(sample.rawMetric, 'region') ?? context.defaultRegion;
    return {
      tenantId: context.tenantId,
      cloudConnectionId: context.cloudConnectionId,
      provider: sample.provider,
      externalResourceId: sample.externalResourceId,
      name: readRawMetricString(sample.rawMetric, 'resourceName') ?? sample.externalResourceId,
      resourceType: inferResourceType(sample),
      serviceName: inferServiceName(sample),
      ...(regionId !== undefined ? { regionId } : {}),
      status: 'UNKNOWN',
      rawResource: {
        source: 'METRIC_DERIVED',
        metricNames: [...metricNames].sort(),
        sampleCount,
      },
    };
  });
}

export function mergeNormalizedResources(
  resources: readonly NormalizedCloudResource[],
): readonly NormalizedCloudResource[] {
  const byKey = new Map<string, NormalizedCloudResource>();

  for (const resource of resources) {
    const key = `${resource.cloudConnectionId}:${resource.externalResourceId}`;
    const previous = byKey.get(key);
    if (previous === undefined || previous.rawResource?.['source'] === 'METRIC_DERIVED') {
      byKey.set(key, resource);
    }
  }

  return [...byKey.values()];
}

function inferResourceType(sample: NormalizedResourceMetricSample): string {
  const namespace = readRawMetricString(sample.rawMetric, 'namespace')?.toLowerCase() ?? '';
  if (namespace.includes('compute') || namespace.includes('ec2') || namespace.includes('vmi')) {
    return 'COMPUTE_INSTANCE';
  }

  if (namespace.includes('block') || namespace.includes('volume') || namespace.includes('ebs')) {
    return 'BLOCK_VOLUME';
  }

  return 'UNKNOWN';
}

function inferServiceName(sample: NormalizedResourceMetricSample): string {
  const namespace = readRawMetricString(sample.rawMetric, 'namespace')?.toLowerCase() ?? '';
  if (namespace.includes('aws/ec2')) {
    return 'Amazon EC2';
  }

  if (namespace.includes('oci_compute') || namespace.includes('oci_computeagent') || namespace.includes('vmi')) {
    return 'Oracle Compute';
  }

  if (namespace.includes('ebs')) {
    return 'Amazon EBS';
  }

  return 'UNKNOWN';
}

function readRawMetricString(
  rawMetric: Readonly<Record<string, unknown>> | undefined,
  field: string,
): string | undefined {
  if (rawMetric === undefined) {
    return undefined;
  }

  const value = rawMetric[field];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
