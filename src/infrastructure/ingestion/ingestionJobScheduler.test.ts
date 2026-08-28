import { describe, expect, it } from 'vitest';
import {
  buildIngestionSchedulePlan,
  type ScheduleableIngestionConnection,
} from './ingestionJobScheduler.js';
import { buildIngestionConfigurationHash } from './ingestionConfigurationHash.js';

const now = new Date('2026-06-05T12:00:00.000Z');
const defaultOptions = {
  now,
  inventoryWindowHours: 24,
  inventoryCooldownHours: 24,
  metricWindowMinutes: 30,
  metricCooldownMinutes: 25,
  billingWindowHours: 24,
  billingCooldownHours: 6,
  maxAttempts: 1,
  metricCatchupDays: 90,
};

describe('buildIngestionSchedulePlan', () => {
  it('schedules a normalized inventory refresh when the provider exposes inventory capability', () => {
    const plan = buildIngestionSchedulePlan([
      buildOciConnection({
        metadata: { capabilityValidation: capabilityValidation(['IDENTITY', 'INVENTORY']) },
      }),
    ], defaultOptions);

    expect(plan.jobs).toContainEqual(expect.objectContaining({
      cloudConnectionId: 'oci_1',
      providerCode: 'oci',
      sourceType: 'INVENTORY',
      targetStart: new Date('2026-06-04T12:00:00.000Z'),
      targetEnd: now,
      reason: 'Inventario de recursos habilitado y sin lectura reciente.',
    }));
  });

  it('schedules technical metrics when metadata and active credentials exist', () => {
    const plan = buildIngestionSchedulePlan([buildOciConnection()], defaultOptions);

    expect(plan.jobs).toContainEqual(expect.objectContaining({
      cloudConnectionId: 'oci_1',
      providerCode: 'oci',
      sourceType: 'TECHNICAL_METRIC',
      targetStart: new Date('2026-03-07T12:00:00.000Z'),
      targetEnd: now,
      maxAttempts: 1,
    }));
  });

  it('schedules a FOCUS billing export when FOCUS metadata exists', () => {
    const plan = buildIngestionSchedulePlan([
      buildAwsConnection({
        metadata: {
          awsMetricDefinitions: [{ metricName: 'CPUUtilization' }],
          awsFocusExportLocations: [{ bucket: 'finops', prefix: 'focus/' }],
          capabilityValidation: capabilityValidation(['IDENTITY', 'METRICS', 'STORAGE']),
        },
        credentials: [{ purpose: 'OPERATIONAL', status: 'ACTIVE' }],
      }),
    ], defaultOptions);

    expect(plan.jobs).toEqual([
      expect.objectContaining({ sourceType: 'TECHNICAL_METRIC' }),
      expect.objectContaining({
        providerCode: 'aws',
        sourceType: 'BILLING_EXPORT',
        targetStart: new Date('2026-06-04T12:00:00.000Z'),
        targetEnd: now,
      }),
    ]);
  });

  it('skips a source when a pending job already exists', () => {
    const plan = buildIngestionSchedulePlan([
      buildOciConnection({
        ingestionJobs: [
          {
            sourceType: 'TECHNICAL_METRIC',
            status: 'PENDING',
            targetEnd: new Date('2026-06-05T11:50:00.000Z'),
          },
        ],
      }),
    ], defaultOptions);

    expect(plan.jobs).not.toContainEqual(expect.objectContaining({ sourceType: 'TECHNICAL_METRIC' }));
    expect(plan.skipped).toContainEqual(expect.objectContaining({
      cloudConnectionId: 'oci_1',
      sourceType: 'TECHNICAL_METRIC',
      reason: 'Ya existe un job PENDING para esta fuente.',
    }));
  });

  it('skips a source when a recent successful job still covers the cooldown window', () => {
    const plan = buildIngestionSchedulePlan([
      buildOciConnection({
        ingestionJobs: [
          {
            sourceType: 'TECHNICAL_METRIC',
            status: 'SUCCESS',
            targetEnd: new Date('2026-06-05T11:40:00.000Z'),
            configurationHash: technicalConfigurationHash(),
          },
        ],
      }),
    ], defaultOptions);

    expect(plan.jobs).not.toContainEqual(expect.objectContaining({ sourceType: 'TECHNICAL_METRIC' }));
    expect(plan.skipped).toContainEqual(expect.objectContaining({
      cloudConnectionId: 'oci_1',
      sourceType: 'TECHNICAL_METRIC',
      reason: 'La fuente ya tiene cobertura reciente hasta 2026-06-05T11:40:00.000Z.',
    }));
  });

  it('uses the provider API for billing in AUTO mode when no FOCUS export is configured', () => {
    const plan = buildIngestionSchedulePlan([
      buildAwsConnection({
        metadata: { capabilityValidation: capabilityValidation(['IDENTITY', 'COSTS']) },
        credentials: [{ purpose: 'OPERATIONAL', status: 'ACTIVE' }],
      }),
    ], defaultOptions);

    expect(plan.jobs).toEqual([
      expect.objectContaining({
        sourceType: 'BILLING_EXPORT',
        providerCode: 'aws',
      }),
    ]);
    expect(plan.skipped).toContainEqual(expect.objectContaining({
      sourceType: 'TECHNICAL_METRIC',
      reason: 'No hay metadata configurada para programar esta fuente sin inventar datos.',
    }));
  });

  it('keeps AUTO billing schedulable with FOCUS metadata when only COSTS is available', () => {
    const plan = buildIngestionSchedulePlan([
      buildOciConnection({
        metadata: {
          ociFocusReportLocations: [{ namespaceName: 'bling', bucketName: 'tenancy', prefix: 'FOCUS Reports' }],
          capabilityValidation: capabilityValidation(['IDENTITY', 'COSTS']),
        },
        credentials: [{ purpose: 'OPERATIONAL', status: 'ACTIVE' }],
      }),
    ], defaultOptions);

    expect(plan.jobs).toContainEqual(expect.objectContaining({
      providerCode: 'oci',
      sourceType: 'BILLING_EXPORT',
    }));
    expect(plan.skipped).not.toContainEqual(expect.objectContaining({
      sourceType: 'BILLING_EXPORT',
    }));
  });

  it('skips every source when the connection has not been validated after configuration changes', () => {
    const plan = buildIngestionSchedulePlan([
      buildOciConnection({ lastValidatedAt: null }),
    ], defaultOptions);

    expect(plan.jobs).toEqual([]);
    expect(plan.skipped).toHaveLength(3);
    expect(plan.skipped.every((item) => item.reason === 'La conexión debe validarse después de su última modificación.')).toBe(true);
  });

  it('skips every source when the capabilities validation is stale', () => {
    const plan = buildIngestionSchedulePlan([
      buildOciConnection({ lastValidatedAt: new Date('2026-06-03T12:00:00.000Z') }),
    ], { ...defaultOptions, validationMaxAgeMinutes: 60 * 24 });

    expect(plan.jobs).toEqual([]);
    expect(plan.skipped).toHaveLength(3);
    expect(plan.skipped.every((item) => item.reason === 'La validación de capacidades expiró; ejecuta una nueva validación antes de ingerir.')).toBe(true);
  });

  it('requires the source-specific capability from the latest validation', () => {
    const plan = buildIngestionSchedulePlan([
      buildOciConnection({
        metadata: {
          ociMetricDefinitions: [{ metricName: 'CpuUtilization' }],
          capabilityValidation: capabilityValidation(['IDENTITY']),
        },
      }),
    ], defaultOptions);

    expect(plan.jobs).toEqual([]);
    expect(plan.skipped).toContainEqual(expect.objectContaining({
      sourceType: 'TECHNICAL_METRIC',
      reason: 'La validación vigente no confirmó la capacidad METRICS para esta fuente.',
    }));
  });

  it('skips sources without active read credentials', () => {
    const plan = buildIngestionSchedulePlan([
      buildOciConnection({
        credentials: [{ purpose: 'OPERATIONAL', status: 'DISABLED' }],
      }),
    ], defaultOptions);

    expect(plan.jobs).toEqual([]);
    expect(plan.skipped).toContainEqual(expect.objectContaining({
      sourceType: 'TECHNICAL_METRIC',
      reason: 'No hay credencial activa con permisos esperados para esta fuente.',
    }));
  });

  it('repairs internal technical gaps oldest-first instead of advancing from the latest sample', () => {
    const plan = buildIngestionSchedulePlan([
      buildOciConnection({
        metricCoverageWindowStarts: [new Date('2026-06-05T00:00:00.000Z')],
      }),
    ], {
      ...defaultOptions,
      metricCatchupDays: 1,
      metricCatchupWindowMinutes: 360,
      maxMetricBackfillJobsPerConnection: 2,
    });

    expect(plan.jobs.filter((job) => job.sourceType === 'TECHNICAL_METRIC')).toEqual([
      expect.objectContaining({
        targetStart: new Date('2026-06-04T12:00:00.000Z'),
        targetEnd: new Date('2026-06-04T18:00:00.000Z'),
      }),
      expect.objectContaining({
        targetStart: new Date('2026-06-04T18:00:00.000Z'),
        targetEnd: new Date('2026-06-05T00:00:00.000Z'),
      }),
    ]);
  });

  it('does not treat a successful job without sample evidence as covered', () => {
    const plan = buildIngestionSchedulePlan([
      buildOciConnection({
        metricCoverageWindowStarts: [],
        ingestionJobs: [{
          sourceType: 'TECHNICAL_METRIC',
          status: 'SUCCESS',
          targetStart: new Date('2026-06-04T12:00:00.000Z'),
          targetEnd: new Date('2026-06-04T18:00:00.000Z'),
          resultSummary: { coverage: { samples: 0 } },
        }],
      }),
    ], { ...defaultOptions, metricCatchupDays: 1, metricCatchupWindowMinutes: 360, maxMetricBackfillJobsPerConnection: 1 });

    expect(plan.jobs).toContainEqual(expect.objectContaining({
      sourceType: 'TECHNICAL_METRIC',
      targetStart: new Date('2026-06-04T12:00:00.000Z'),
    }));
  });

  it('does not recreate a successful window explicitly classified as no data', () => {
    const plan = buildIngestionSchedulePlan([
      buildOciConnection({
        metricCoverageWindowStarts: [],
        ingestionJobs: [{
          sourceType: 'TECHNICAL_METRIC',
          status: 'SUCCESS',
          dataOutcome: 'NO_DATA',
          targetStart: new Date('2026-06-04T12:00:00.000Z'),
          targetEnd: new Date('2026-06-04T18:00:00.000Z'),
          resultSummary: { coverage: { samples: 0 } },
        }],
      }),
    ], { ...defaultOptions, metricCatchupDays: 1, metricCatchupWindowMinutes: 360, maxMetricBackfillJobsPerConnection: 1 });

    expect(plan.jobs).not.toContainEqual(expect.objectContaining({
      sourceType: 'TECHNICAL_METRIC',
      targetStart: new Date('2026-06-04T12:00:00.000Z'),
    }));
  });

  it('retries a failed technical window with a stale configuration even when partial samples exist', () => {
    const plan = buildIngestionSchedulePlan([buildOciConnection({
      metricCoverageWindowStarts: [new Date('2026-06-04T12:00:00.000Z')],
      ingestionJobs: [{
        sourceType: 'TECHNICAL_METRIC',
        status: 'FAILED',
        targetStart: new Date('2026-06-04T12:00:00.000Z'),
        targetEnd: new Date('2026-06-04T18:00:00.000Z'),
        configurationHash: 'legacy-configuration',
      }],
    })], { ...defaultOptions, metricCatchupDays: 1, metricCatchupWindowMinutes: 360, maxMetricBackfillJobsPerConnection: 1 });

    expect(plan.jobs).toContainEqual(expect.objectContaining({
      sourceType: 'TECHNICAL_METRIC',
      targetStart: new Date('2026-06-04T12:00:00.000Z'),
      targetEnd: new Date('2026-06-04T18:00:00.000Z'),
      reason: expect.stringContaining('configuración anterior'),
    }));
  });
});

function buildOciConnection(
  overrides: Partial<ScheduleableIngestionConnection> = {},
): ScheduleableIngestionConnection {
  return {
    id: 'oci_1',
    tenantId: 'tenant_1',
    providerCode: 'oci',
    lastValidatedAt: new Date('2026-06-05T10:00:00.000Z'),
    metadata: {
      ociMetricDefinitions: [{ metricName: 'CpuUtilization' }],
      capabilityValidation: capabilityValidation(['IDENTITY', 'METRICS', 'COSTS']),
    },
    credentials: [{ purpose: 'OPERATIONAL', status: 'ACTIVE' }],
    ingestionJobs: [],
    ...overrides,
  };
}

function buildAwsConnection(
  overrides: Partial<ScheduleableIngestionConnection> = {},
): ScheduleableIngestionConnection {
  return {
    id: 'aws_1',
    tenantId: 'tenant_1',
    providerCode: 'aws',
    lastValidatedAt: new Date('2026-06-05T10:00:00.000Z'),
    metadata: {
      awsMetricDefinitions: [{ metricName: 'CPUUtilization' }],
      capabilityValidation: capabilityValidation(['IDENTITY', 'METRICS', 'COSTS']),
    },
    credentials: [{ purpose: 'METRICS_READ', status: 'ACTIVE' }],
    ingestionJobs: [],
    ...overrides,
  };
}

function capabilityValidation(capabilities: readonly string[]): Readonly<Record<string, unknown>> {
  return {
    checkedAt: '2026-06-05T10:00:00.000Z',
    capabilities: capabilities.map((capability) => ({ capability, status: 'AVAILABLE' })),
  };
}

function technicalConfigurationHash(): string {
  const connection = buildOciConnection();
  return buildIngestionConfigurationHash({
    providerCode: 'oci',
    sourceType: 'TECHNICAL_METRIC',
    metadata: connection.metadata,
    requestContext: { interval: '30m', resolutionSeconds: 1800 },
  });
}
