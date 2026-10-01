import { describe, expect, test } from 'vitest';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { PrismaMetricCoveragePersistence } from '../infrastructure/ingestion/PrismaMetricCoveragePersistence.js';
import {
  cleanupE2eFixtures,
  createE2eFixtures,
  createTestingPrismaClient,
} from './e2eFixtures.js';

describe('selective metric coverage PostgreSQL integration', () => {
  test.skipIf(process.env['RUN_DB_INTEGRATION_TESTS'] !== 'true')(
    'limits a filtered OCI job to its requested metric and preserves broad coverage for unfiltered jobs',
    async () => {
      const prisma = createTestingPrismaClient();
      const runId = `coverage-filter-${Date.now()}`;
      try {
        const fixtures = await createE2eFixtures(prisma, runId);
        const tenant = fixtures.tenants[1];
        expect(tenant).toBeDefined();
        const connection = await prisma.cloudConnection.findFirstOrThrow({
          where: { tenantId: tenant!.id, providerCode: 'oci' },
          select: { id: true },
        });
        const resourceId = `ocid1.vnic.oc1..exampleid0033.${runId}`;
        const definitions = buildDefinitions(tenant!.id, connection.id, runId, resourceId);
        await prisma.cloudMetricDefinition.createMany({ data: definitions });

        const targetStart = new Date('2026-09-23T20:00:00.000Z');
        const targetEnd = new Date('2026-09-23T20:30:00.000Z');
        const filteredJob = await createMetricJob(prisma, {
          tenantId: tenant!.id,
          connectionId: connection.id,
          runId,
          targetStart,
          targetEnd,
          requestContext: {
            resolutionSeconds: 1800,
            regionId: 'us-ashburn-1',
            metricFilter: {
              namespace: 'oci_vcn',
              metricName: 'VnicFromNetworkBytes',
              resourceId: resourceId.toUpperCase(),
              regionId: 'us-ashburn-1',
              statistic: 'MEAN',
            },
          },
        });

        await prisma.resourceMetricSample.createMany({
          data: [
            {
              tenantId: tenant!.id,
              cloudConnectionId: connection.id,
              provider: 'OCI',
              externalResourceId: resourceId,
              providerNamespace: 'oci_vcn',
              regionId: 'us-ashburn-1',
              metricName: 'VnicFromNetworkBytes',
              statistic: 'MEAN',
              dimensionsHash: `dimensions-a-${runId}`,
              value: new Prisma.Decimal(120),
              sampledAt: new Date('2026-09-23T20:15:00.000Z'),
              granularitySeconds: 1800,
              sourceType: 'TECHNICAL_METRIC',
              ingestionJobId: filteredJob.id,
            },
            {
              tenantId: tenant!.id,
              cloudConnectionId: connection.id,
              provider: 'OCI',
              externalResourceId: resourceId,
              providerNamespace: 'oci_vcn',
              regionId: 'us-ashburn-1',
              metricName: 'VnicFromNetworkPackets',
              statistic: 'MEAN',
              dimensionsHash: `other-${runId}`,
              value: new Prisma.Decimal(15),
              sampledAt: new Date('2026-09-23T20:15:00.000Z'),
              granularitySeconds: 1800,
              sourceType: 'TECHNICAL_METRIC',
            },
          ],
        });

        const coverage = new PrismaMetricCoveragePersistence();
        const now = new Date('2026-09-24T00:00:00.000Z');
        await prisma.resourceMetricCoverageWindow.create({
          data: {
            tenantId: tenant!.id,
            cloudConnectionId: connection.id,
            ingestionJobId: filteredJob.id,
            streamKey: `stale-${runId}`,
            providerNamespace: 'oci_vcn',
            regionId: 'us-ashburn-1',
            externalResourceId: resourceId,
            metricName: 'VnicFromNetworkPackets',
            statistic: 'MEAN',
            granularitySeconds: 1800,
            windowStart: new Date('2026-09-23T00:00:00.000Z'),
            windowEnd: new Date('2026-09-24T00:00:00.000Z'),
            status: 'NO_DATA',
            expectedSamples: 48,
            observedSamples: 0,
            missingSamples: 48,
            configurationHash: `filtered-${runId}`,
            evidence: { legacyProjection: true },
          },
        });
        await prisma.$transaction((tx) => coverage.refreshForJob(tx, filteredJob.id, now));
        const filteredWindows = await prisma.resourceMetricCoverageWindow.findMany({
          where: { ingestionJobId: filteredJob.id },
          orderBy: { streamKey: 'asc' },
        });

        expect(filteredWindows).toHaveLength(2);
        expect(filteredWindows.every((window) => (
          window.providerNamespace === 'oci_vcn'
          && window.metricName === 'VnicFromNetworkBytes'
          && window.externalResourceId === resourceId
          && window.regionId === 'us-ashburn-1'
          && window.statistic === 'MEAN'
        ))).toBe(true);
        expect(filteredWindows.map((window) => window.observedSamples).sort()).toEqual([0, 1]);

        const broadJob = await createMetricJob(prisma, {
          tenantId: tenant!.id,
          connectionId: connection.id,
          runId,
          targetStart,
          targetEnd,
          requestContext: { resolutionSeconds: 1800 },
          configurationSuffix: 'broad',
        });
        await prisma.$transaction((tx) => coverage.refreshForJob(tx, broadJob.id, now));
        const broadWindows = await prisma.resourceMetricCoverageWindow.findMany({
          where: { ingestionJobId: broadJob.id },
        });
        expect(broadWindows.length).toBeGreaterThanOrEqual(7);
        expect(broadWindows.some((window) => window.metricName === 'VnicFromNetworkPackets')).toBe(true);
        expect(broadWindows.some((window) => window.regionId === 'us-phoenix-1')).toBe(true);
      } finally {
        await cleanupE2eFixtures(prisma, runId);
        await prisma.$disconnect();
      }
    },
    30_000,
  );
});

function buildDefinitions(tenantId: string, connectionId: string, runId: string, resourceId: string) {
  const now = new Date('2026-09-24T00:00:00.000Z');
  return [
    { namespace: 'oci_vcn', metricName: 'VnicFromNetworkBytes', externalResourceId: resourceId, regionId: 'us-ashburn-1', dimensionsHash: `dimensions-a-${runId}`, statistics: ['MEAN', 'MAX'] },
    { namespace: 'oci_vcn', metricName: 'VnicFromNetworkBytes', externalResourceId: resourceId, regionId: 'us-ashburn-1', dimensionsHash: `dimensions-b-${runId}`, statistics: ['MEAN'] },
    { namespace: 'oci_vcn', metricName: 'VnicFromNetworkBytes', externalResourceId: resourceId, regionId: 'us-phoenix-1', dimensionsHash: `wrong-region-${runId}`, statistics: ['MEAN'] },
    { namespace: 'oci_vcn', metricName: 'VnicFromNetworkPackets', externalResourceId: resourceId, regionId: 'us-ashburn-1', dimensionsHash: `other-metric-${runId}`, statistics: ['MEAN'] },
    { namespace: 'oci_vcn', metricName: 'VnicFromNetworkBytes', externalResourceId: `${resourceId}-other`, regionId: 'us-ashburn-1', dimensionsHash: `other-resource-${runId}`, statistics: ['MEAN'] },
    { namespace: 'oci_computeagent', metricName: 'VnicFromNetworkBytes', externalResourceId: resourceId, regionId: 'us-ashburn-1', dimensionsHash: `other-namespace-${runId}`, statistics: ['MEAN'] },
  ].map((definition) => ({
    tenantId,
    cloudConnectionId: connectionId,
    compartmentId: `compartment-${runId}`,
    ...definition,
    dimensions: { resourceId: definition.externalResourceId },
    statistics: definition.statistics as Prisma.InputJsonValue,
    status: 'CONFIRMED',
    enabled: true,
    discoverySource: 'OCI_LIST_METRICS',
    firstSeenAt: now,
    lastSeenAt: now,
  }));
}

async function createMetricJob(prisma: PrismaClient, input: {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly runId: string;
  readonly targetStart: Date;
  readonly targetEnd: Date;
  readonly requestContext: Prisma.InputJsonValue;
  readonly configurationSuffix?: string;
}) {
  return prisma.ingestionJob.create({
    data: {
      tenantId: input.tenantId,
      cloudConnectionId: input.connectionId,
      sourceType: 'TECHNICAL_METRIC',
      status: 'SUCCESS',
      targetStart: input.targetStart,
      targetEnd: input.targetEnd,
      configurationHash: `${input.configurationSuffix ?? 'filtered'}-${input.runId}`,
      requestContext: input.requestContext,
      completedAt: input.targetEnd,
    },
    select: { id: true },
  });
}
