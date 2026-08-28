import { describe, expect, test } from 'vitest';
import type { CloudIngestionJobContext } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { OciBillingCollector } from './OciBillingCollector.js';

describe('OCI billing collector', () => {
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

    expect(receivedSignal).toBe(controller.signal);
    expect(requestCount).toBe(0);
    expect(closed).toBe(true);
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
