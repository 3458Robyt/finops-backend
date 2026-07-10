import { describe, expect, it } from 'vitest';
import {
  buildIngestionReadinessSummary,
  isValidCredentialEncryptionKey,
  summarizeReadinessJobResult,
  summarizeReadinessMetadata,
} from './ingestionReadiness.js';

describe('ingestionReadiness', () => {
  it('summarizes provider-specific metadata counts', () => {
    expect(summarizeReadinessMetadata('oci', {
      ociMetricDefinitions: [{ metricName: 'CpuUtilization' }],
      ociFocusReportObjects: [],
      ociFocusReportLocations: [{ bucketName: 'reports' }],
    })).toEqual({
      ociMetricDefinitions: 1,
      ociFocusReportObjects: 0,
      ociFocusReportLocations: 1,
    });

    expect(summarizeReadinessMetadata('aws', {
      awsMetricDefinitions: [],
      awsFocusExportObjects: [{ bucket: 'finops' }],
      awsFocusExportLocations: [],
    })).toEqual({
      awsMetricDefinitions: 0,
      awsFocusExportObjects: 1,
      awsFocusExportLocations: 0,
    });
  });

  it('builds a readiness summary with credential and metadata issues', () => {
    const summary = buildIngestionReadinessSummary({
      generatedAt: new Date('2026-06-05T12:00:00.000Z'),
      missingProviderMessageSuffix: ' for this tenant',
      connections: [
        {
          id: 'oci-1',
          name: 'OCI TAK',
          providerCode: 'oci',
          metadata: {
            ociMetricDefinitions: [{ metricName: 'CpuUtilization' }],
          },
          credentialPurposes: ['OPERATIONAL'],
          recentJobs: [
            {
              id: 'job-1',
              sourceType: 'TECHNICAL_METRIC',
              status: 'SUCCESS',
              targetStart: new Date('2026-06-05T11:00:00.000Z'),
              targetEnd: new Date('2026-06-05T11:30:00.000Z'),
              completedAt: new Date('2026-06-05T11:31:00.000Z'),
              errorMessage: null,
              resultSummary: { metricSamples: 11, apiCallCount: 11 },
            },
          ],
        },
      ],
    });

    expect(summary.ok).toBe(true);
    expect(summary.connections[0]).toMatchObject({
      id: 'oci-1',
      credentialPurposes: ['OPERATIONAL'],
      metadataCounts: {
        ociMetricDefinitions: 1,
        ociFocusReportObjects: 0,
        ociFocusReportLocations: 0,
      },
    });
    expect(summary.connections[0]?.recentJobs[0]?.summary).toMatchObject({
      metricSamples: 11,
      apiCallCount: 11,
    });
    expect(summary.issues).toContainEqual({
      provider: 'oci',
      severity: 'WARNING',
      message: 'Missing OCI FOCUS object/prefix metadata for billing exports.',
    });
    expect(summary.issues).toContainEqual({
      provider: 'aws',
      severity: 'WARNING',
      message: 'No active AWS cloud connection found for this tenant.',
    });
  });

  it('marks readiness as blocked when credentials are missing', () => {
    const summary = buildIngestionReadinessSummary({
      generatedAt: new Date('2026-06-05T12:00:00.000Z'),
      connections: [
        {
          id: 'aws-1',
          name: 'AWS',
          providerCode: 'aws',
          metadata: {
            awsMetricDefinitions: [{ metricName: 'CPUUtilization' }],
            awsFocusExportLocations: [{ bucket: 'finops' }],
          },
          credentialPurposes: [],
          recentJobs: [],
        },
      ],
    });

    expect(summary.ok).toBe(false);
    expect(summary.issues).toContainEqual({
      provider: 'aws',
      severity: 'BLOCKER',
      message: 'No active operational/read credential is stored for this provider.',
    });
  });

  it('summarizes only safe job result fields', () => {
    expect(summarizeReadinessJobResult({
      providerCode: 'oci',
      sourceType: 'TECHNICAL_METRIC',
      apiCallCount: 11,
      metricSamples: 11,
      secret: 'do-not-return',
    })).toEqual({
      providerCode: 'oci',
      sourceType: 'TECHNICAL_METRIC',
      apiCallCount: 11,
      objectsProcessed: undefined,
      focusRows: undefined,
      metricSamples: 11,
      warnings: undefined,
    });
  });

  it('validates 32-byte base64 credential encryption keys', () => {
    expect(isValidCredentialEncryptionKey(Buffer.alloc(32).toString('base64'))).toBe(true);
    expect(isValidCredentialEncryptionKey(Buffer.alloc(16).toString('base64'))).toBe(false);
    expect(isValidCredentialEncryptionKey(undefined)).toBe(false);
  });
});
