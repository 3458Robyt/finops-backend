import { describe, expect, test, vi } from 'vitest';
import type { CloudIngestionJobContext } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { PrismaIngestionPersistenceClient } from './ingestionPersistenceTypes.js';
import { PrismaIngestionJobCompletionSupport, type IngestionJobExecutionSummary } from './PrismaIngestionJobCompletionSupport.js';

describe('PrismaIngestionJobCompletionSupport', () => {
  test('persists provider billing coverage for the effective queried range', async () => {
    const requested = {
      start: new Date('2026-09-20T02:00:00Z'),
      end: new Date('2026-09-20T03:00:00Z'),
    };
    const effectiveRange = {
      start: new Date('2026-09-19T00:00:00Z'),
      end: new Date('2026-09-20T00:00:00Z'),
    };
    const job = {
      id: 'job-1', tenantId: 'tenant-1', cloudConnectionId: 'connection-1',
      sourceType: 'BILLING_EXPORT', targetStart: requested.start, targetEnd: requested.end,
      connection: { providerCode: 'oci' },
    } as unknown as CloudIngestionJobContext;
    const summary = {
      durationMs: 1, providerCode: 'oci', sourceType: 'BILLING_EXPORT', dataOutcome: 'DATA_WRITTEN',
      apiCallCount: 1, objectsProcessed: 0, focusRows: 0, focusRowsInserted: 0,
      costMetrics: 129, costMetricsInserted: 2, resources: 0, metricDerivedResources: 0,
      metricSamples: 0, metricSamplesInserted: 0, projectionStatus: 'NOT_REQUIRED',
      metricSamplesLinkedToResource: 0,
      resourceLinkage: { costs: { linked: 0, unresolved: 0, reasons: {} }, metrics: { linked: 0, unresolved: 0, reasons: {} } },
      warnings: [], coverage: { billingSource: 'PROVIDER_API', rows: 129 }, effectiveRange,
    } as unknown as IngestionJobExecutionSummary;
    const upsert = vi.fn();
    const create = vi.fn();
    const tx = {
      ingestionWatermark: { upsert },
      ingestionCoverageSegment: { create },
    } as unknown as PrismaIngestionPersistenceClient;
    const support = new PrismaIngestionJobCompletionSupport();

    await support.updateWatermark(tx, job, summary);
    await support.recordCoverageSegment(tx, job, summary);

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ watermarkStart: effectiveRange.start, watermarkEnd: effectiveRange.end }),
    }));
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({
      targetStart: effectiveRange.start,
      targetEnd: effectiveRange.end,
      rowsWritten: 2,
    }) });
  });
});
