import { describe, expect, it } from 'vitest';
import {
  buildIngestionSchedulePlan,
  type ScheduleableIngestionConnection,
} from './ingestionJobScheduler.js';

const now = new Date('2026-06-05T12:00:00.000Z');
const defaultOptions = {
  now,
  metricWindowMinutes: 30,
  metricCooldownMinutes: 25,
  billingWindowHours: 24,
  billingCooldownHours: 6,
  maxAttempts: 1,
};

describe('buildIngestionSchedulePlan', () => {
  it('schedules technical metrics when metadata and active credentials exist', () => {
    const plan = buildIngestionSchedulePlan([buildOciConnection()], defaultOptions);

    expect(plan.jobs).toContainEqual(expect.objectContaining({
      cloudConnectionId: 'oci_1',
      providerCode: 'oci',
      sourceType: 'TECHNICAL_METRIC',
      targetStart: new Date('2026-06-05T11:30:00.000Z'),
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
        metadata: {},
        credentials: [{ purpose: 'OPERATIONAL', status: 'ACTIVE' }],
      }),
    ], defaultOptions);

    expect(plan.jobs).toEqual([
      expect.objectContaining({
        sourceType: 'BILLING_EXPORT',
        providerCode: 'aws',
      }),
    ]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({
        sourceType: 'TECHNICAL_METRIC',
        reason: 'No hay metadata configurada para programar esta fuente sin inventar datos.',
      }),
    ]);
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
});

function buildOciConnection(
  overrides: Partial<ScheduleableIngestionConnection> = {},
): ScheduleableIngestionConnection {
  return {
    id: 'oci_1',
    tenantId: 'tenant_1',
    providerCode: 'oci',
    metadata: {
      ociMetricDefinitions: [{ metricName: 'CpuUtilization' }],
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
    metadata: {
      awsMetricDefinitions: [{ metricName: 'CPUUtilization' }],
    },
    credentials: [{ purpose: 'METRICS_READ', status: 'ACTIVE' }],
    ingestionJobs: [],
    ...overrides,
  };
}
