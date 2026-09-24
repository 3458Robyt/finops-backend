import { describe, expect, test, vi } from 'vitest';
import type { CloudIngestionJobContext } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { FOCUS_1_0_MANDATORY_COLUMNS } from '../focusSchemaValidation.js';
import { OciBillingCollector } from './OciBillingCollector.js';

describe('OCI billing collector', () => {
  test('exposes the actual complete-day range queried for a narrow Usage API job', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-22T12:00:00Z') });
    try {
    let requestedRange: { timeUsageStarted?: Date; timeUsageEnded?: Date } | undefined;
    const collector = new OciBillingCollector({
      createObjectStorageClient: () => ({
        listObjects: async () => ({ listObjects: { objects: [] } }),
        getObject: async () => ({ value: '' }),
      }),
      createUsageClient: () => ({
        requestSummarizedUsages: async (request) => {
          requestedRange = request.requestSummarizedUsagesDetails;
          return { usageAggregation: { items: [] } };
        },
      }),
    });

    const job = buildJob();
    const result = await collector.collect({
      ...job,
      targetStart: new Date('2026-09-20T02:00:00Z'),
      targetEnd: new Date('2026-09-20T03:00:00Z'),
      connection: { ...job.connection, metadata: { billingSourceMode: 'PROVIDER_API' } },
    });

    expect(requestedRange).toMatchObject({
      timeUsageStarted: new Date('2026-09-20T00:00:00Z'),
      timeUsageEnded: new Date('2026-09-21T00:00:00Z'),
    });
    expect(result.effectiveRange).toEqual({
      start: new Date('2026-09-20T00:00:00Z'),
      end: new Date('2026-09-21T00:00:00Z'),
    });
    expect(result.dataOutcome).toBe('NO_DATA');
    } finally {
      vi.useRealTimers();
    }
  });

  test('marks a current-day-only request partial instead of claiming it was covered', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-20T02:30:00Z') });
    try {
      const collector = new OciBillingCollector({
        createObjectStorageClient: () => ({
          listObjects: async () => ({ listObjects: { objects: [] } }),
          getObject: async () => ({ value: '' }),
        }),
        createUsageClient: () => ({
          requestSummarizedUsages: async () => ({
            usageAggregation: { items: [{ service: 'Compute', computedAmount: 4, currency: 'USD' }] },
          }),
        }),
      });
      const job = buildJob();
      const result = await collector.collect({
        ...job,
        targetStart: new Date('2026-09-20T02:00:00Z'),
        targetEnd: new Date('2026-09-20T03:00:00Z'),
        connection: { ...job.connection, metadata: { billingSourceMode: 'PROVIDER_API' } },
      });

      expect(result.effectiveRange).toEqual({
        start: new Date('2026-09-19T00:00:00Z'),
        end: new Date('2026-09-20T00:00:00Z'),
      });
      expect(result.dataOutcome).toBe('PARTIAL');
      expect(result.warnings.some((warning) => warning.includes('no quedó cubierta íntegramente'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps AUTO billing as partial coverage when FOCUS has no current object and Usage API is denied', async () => {
    const collector = new OciBillingCollector({
      createObjectStorageClient: () => ({
        listObjects: async () => ({ listObjects: { objects: [] } }),
        getObject: async () => ({ value: '' }),
      }),
      createUsageClient: () => ({
        requestSummarizedUsages: async () => {
          throw Object.assign(new Error('Authorization failed or requested resource not found.'), { statusCode: 404 });
        },
      }),
    });

    const result = await collector.collect(buildJob());

    expect(result.apiCallCount).toBe(1);
    expect(result.focusRows).toEqual([]);
    expect(result.warnings).toEqual([
      'No se encontraron objetos de reporte FOCUS OCI configurados o descubiertos. Configura ociFocusReportObjects u ociFocusReportLocations.',
      'OCI Usage API tampoco estuvo disponible; el periodo queda pendiente de una nueva sincronizacion.',
    ]);
    expect(result.coverage).toMatchObject({
      billingSourceFallback: 'FOCUS_TO_PROVIDER_API',
      apiCallCount: 1,
    });
  });

  test('warns on missing mandatory FOCUS headers without dropping usable cost rows', async () => {
    const headers = FOCUS_1_0_MANDATORY_COLUMNS.filter(
      (column) => column !== 'ChargeClass' && column !== 'ContractedCost',
    );
    const values: Readonly<Record<string, string>> = {
      BilledCost: '25',
      BillingCurrency: 'USD',
      BillingAccountId: 'account-1',
      BillingAccountName: 'Test account',
      BillingPeriodStart: '2026-08-01T00:00:00Z',
      BillingPeriodEnd: '2026-09-01T00:00:00Z',
      ChargeCategory: 'Usage',
      ChargePeriodStart: '2026-08-23T00:00:00Z',
      ChargePeriodEnd: '2026-08-23T01:00:00Z',
      EffectiveCost: '25',
      InvoiceIssuer: 'Oracle',
      PricingUnit: 'Hours',
      Provider: 'Oracle',
      Publisher: 'Oracle',
      ServiceCategory: 'Compute',
      ServiceName: 'Compute',
    };
    const csv = [headers.join(','), headers.map((header) => values[header] ?? '').join(',')].join('\n');
    const collector = new OciBillingCollector({
      createObjectStorageClient: () => ({
        listObjects: async () => ({ listObjects: { objects: [{ name: 'FOCUS Reports/2026/08/23/report.csv' }] } }),
        getObject: async () => ({ value: csv }),
      }),
      createUsageClient: () => ({ requestSummarizedUsages: async () => ({ usageAggregation: { items: [] } }) }),
    });

    const result = await collector.collect(buildJob());
    const rows = [];
    for await (const batch of result.focusBatches ?? []) rows.push(...batch);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ billedCost: 25, billingCurrency: 'USD' });
    expect(result.warnings).toContain(
      'FOCUS 1.0: uno o más archivos omiten columnas obligatorias. Se conservaron las filas disponibles, pero no se certifica conformidad; revisa el resumen de esquema del job.',
    );
    expect(result.coverage['focusSchemaValidation']).toMatchObject({
      status: 'NONCONFORMANT',
      filesChecked: 1,
      filesNonconformant: 1,
      missingMandatoryColumns: ['ChargeClass', 'ContractedCost'],
    });
  });

  test('stops before the first billing request when the job is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    let requestCount = 0;
    let receivedSignal: AbortSignal | undefined;
    let closed = false;
    const collector = new OciBillingCollector({
      createObjectStorageClient: () => ({
        listObjects: async () => ({ listObjects: { objects: [] } }),
        getObject: async () => ({ value: '' }),
      }),
      createUsageClient: (_job, signal) => {
        receivedSignal = signal;
        return {
          requestSummarizedUsages: async () => {
            requestCount += 1;
            return { usageAggregation: { items: [] } };
          },
          close: () => { closed = true; },
        };
      },
    });

    await expect(collector.collect({
      ...buildJob(),
      connection: { ...buildJob().connection, metadata: { billingSourceMode: 'PROVIDER_API' } },
    }, { signal: controller.signal })).rejects.toThrow('cancelled');

    expect(receivedSignal).toBeUndefined();
    expect(requestCount).toBe(0);
    expect(closed).toBe(false);
  });
});

function buildJob(): CloudIngestionJobContext {
  return {
    id: 'billing-job-1',
    tenantId: 'tenant-1',
    cloudConnectionId: 'connection-1',
    sourceType: 'BILLING_EXPORT',
    targetStart: new Date('2026-08-23T00:00:00Z'),
    targetEnd: new Date('2026-08-24T00:00:00Z'),
    connection: {
      id: 'connection-1',
      tenantId: 'tenant-1',
      providerCode: 'oci',
      rootExternalId: 'tenancy-1',
      credentials: [],
      metadata: {
        ociFocusReportLocations: [{
          namespaceName: 'bling',
          bucketName: 'bucket-1',
          prefix: 'FOCUS Reports/',
          focusVersion: '1.0',
          maxObjects: 20,
        }],
      },
    },
  };
}
