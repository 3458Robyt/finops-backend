import { describe, expect, test } from 'vitest';
import type { CloudIngestionConnection } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import {
  buildOciValidationJob,
  safeOciProviderError,
  validateOciCapabilities,
  validateOciCall,
  withOciClient,
} from './OciCapabilityValidator.js';

describe('OCI capability validation helpers', () => {
  test('builds the same bounded inventory validation window', () => {
    const job = buildOciValidationJob(buildConnection());
    expect(job).toMatchObject({
      id: 'validation-connection-1',
      sourceType: 'INVENTORY',
      attempt: 0,
    });
    expect(job.targetEnd.getTime() - job.targetStart.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  test('redacts provider secrets and bounds diagnostic output', () => {
    const message = safeOciProviderError(new Error(`privateKey=secret ${'x'.repeat(400)}`));
    expect(message).not.toContain('secret');
    expect(message).toContain('privateKey=[REDACTED]');
    expect(message.length).toBeLessThanOrEqual(300);
  });

  test('maps authorization failures without exposing the provider message', async () => {
    const result = await validateOciCall('IDENTITY', new Date('2026-08-11T00:00:00Z'), async () => {
      throw new Error('403 Forbidden token=secret');
    });
    expect(result).toMatchObject({ capability: 'IDENTITY', status: 'DENIED' });
    expect(result.message).toMatch(/policies de solo lectura/i);
    expect(result.message).not.toContain('secret');
  });

  test('always closes OCI clients', async () => {
    let closed = false;
    await expect(withOciClient({ close: () => { closed = true; } }, async () => 'ok')).resolves.toBe('ok');
    expect(closed).toBe(true);
  });

  test('stops dependent OCI calls after a rejected HTTP signature', async () => {
    let computeCalls = 0;
    let monitoringCalls = 0;
    const result = await validateOciCapabilities(buildConnectionWithCredential(), {
      providerCode: 'oci',
      createAuthProvider: () => ({}) as never,
      createIdentityClient: () => ({
        getUser: async () => { throw Object.assign(new Error('Failed to verify the HTTP(S) Signature'), { statusCode: 401 }); },
      }),
      createComputeClient: () => { computeCalls += 1; return { listInstances: async () => ({}) }; },
      createMonitoringClient: () => { monitoringCalls += 1; return { listMetrics: async () => ({}) }; },
      validateStorage: async () => ({
        capability: 'STORAGE', status: 'AVAILABLE', message: 'should not run', checkedAt: new Date(),
      }),
    });

    expect(result.authentication).toMatchObject({ status: 'REJECTED' });
    expect(result.capabilities.find((item) => item.capability === 'INVENTORY')).toMatchObject({ status: 'BLOCKED' });
    expect(computeCalls).toBe(0);
    expect(monitoringCalls).toBe(0);
  });
});

function buildConnection(): CloudIngestionConnection {
  return {
    id: 'connection-1',
    tenantId: 'tenant-1',
    providerCode: 'oci',
    rootExternalId: 'ocid1.tenancy.oc1.test',
    credentials: [],
  };
}

function buildConnectionWithCredential(): CloudIngestionConnection {
  return {
    ...buildConnection(),
    credentials: [{
      purpose: 'OPERATIONAL',
      payload: {
        userId: 'ocid1.user.oc1.test',
        tenancyId: 'ocid1.tenancy.oc1.test',
        fingerprint: '00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff',
        privateKey: 'not-used-by-this-test',
      },
    }],
  };
}
