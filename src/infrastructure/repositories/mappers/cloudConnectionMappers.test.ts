import { describe, expect, it } from 'vitest';
import { sanitizePublicConnectionMetadata } from './cloudConnectionMappers.js';

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
