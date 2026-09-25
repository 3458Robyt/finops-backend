import { describe, expect, it } from 'vitest';
import { sanitizePublicConnectionMetadata, toIngestionJobHistoryItem } from './cloudConnectionMappers.js';

describe('sanitizePublicConnectionMetadata', () => {
  it('solo expone configuración conocida y elimina secretos anidados', () => {
    const result = sanitizePublicConnectionMetadata({
      billingSourceMode: 'AUTO',
      arbitrary: { password: 'not-public' },
      capabilityValidation: {
        providerCode: 'aws',
        privateKey: 'not-public',
        capabilities: [{
          capability: 'IDENTITY',
          status: 'AVAILABLE',
          metadata: { accountId: '123456789012', sessionToken: 'not-public' },
        }],
      },
      awsMetricDefinitions: [{ externalResourceId: 'i-123', metricName: 'CPUUtilization' }],
    });

    expect(result).toEqual({
      billingSourceMode: 'AUTO',
      capabilityValidation: {
        providerCode: 'aws',
        capabilities: [{
          capability: 'IDENTITY',
          status: 'AVAILABLE',
          metadata: { accountId: '123456789012' },
        }],
      },
      awsMetricDefinitions: [{ externalResourceId: 'i-123', metricName: 'CPUUtilization' }],
    });
  });
});

describe('toIngestionJobHistoryItem', () => {
  it('shows the authoritative terminal status for legacy canceled jobs with stale progress', () => {
    const now = new Date('2026-09-25T00:00:00.000Z');
    const job = {
      id: 'job-1',
      cloudConnectionId: 'connection-1',
      sourceType: 'TECHNICAL_METRIC',
      status: 'CANCELLED',
      projectionStatus: 'NOT_REQUIRED',
      projectionAttempts: 0,
      projectionMaxAttempts: 3,
      projectionAvailableAt: null,
      projectionStartedAt: null,
      projectionCompletedAt: null,
      projectionErrorMessage: null,
      dataOutcome: null,
      attempts: 0,
      maxAttempts: 3,
      targetStart: now,
      targetEnd: now,
      errorMessage: null,
      progress: { phase: 'QUEUED', message: 'Esperando en cola.' },
      resultSummary: null,
      priority: 100,
      startedAt: null,
      completedAt: now,
      availableAt: now,
      cancelRequestedAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    } as unknown as Parameters<typeof toIngestionJobHistoryItem>[0];

    expect(toIngestionJobHistoryItem(job).progress).toMatchObject({
      phase: 'CANCELLED',
      message: 'Trabajo cancelado. Detalle histórico no disponible.',
    });
  });
});
