import { describe, expect, test } from 'vitest';
import type { CloudIngestionConnection } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import {
  buildOciValidationJob,
  safeOciProviderError,
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
