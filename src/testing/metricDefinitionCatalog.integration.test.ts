import { describe, expect, test } from 'vitest';
import { PrismaCloudConnectionConfigurationRepository } from '../infrastructure/repositories/PrismaCloudConnectionConfigurationRepository.js';
import { PrismaCloudCredentialRepository } from '../infrastructure/repositories/PrismaCloudCredentialRepository.js';
import { cleanupE2eFixtures, createE2eFixtures, createTestingPrismaClient } from './e2eFixtures.js';

describe('OCI metric definition catalog PostgreSQL integration', () => {
  test.skipIf(process.env['RUN_DB_INTEGRATION_TESTS'] !== 'true')('explicitly saved definitions are queryable from the normalized catalog', async () => {
    const prisma = createTestingPrismaClient();
    const runId = `metric-catalog-${Date.now()}`;
    try {
      const fixtures = await createE2eFixtures(prisma, runId);
      const tenantId = fixtures.tenants[1]!.id;
      const connection = await prisma.cloudConnection.findFirstOrThrow({
        where: { tenantId, providerCode: 'oci' },
        select: { id: true },
      });
      const dimensions = { availabilityDomain: 'AD-1', resourceId: `ocid1.instance.oc1..exampleid0014.${runId}` };
      const repository = new PrismaCloudConnectionConfigurationRepository(prisma);

      await repository.configureMetricDefinitionsForConnection({
        tenantId,
        cloudConnectionId: connection.id,
        replace: false,
        definitions: [{
          compartmentId: 'e2e-compartment', namespace: 'oci_computeagent', metricName: 'CpuUtilization',
          resourceId: dimensions.resourceId, regionId: 'us-ashburn-1', dimensions, statistics: ['MEAN', 'MAX'], unit: 'Percent',
        }],
      });
      await repository.configureMetricDefinitionsForConnection({
        tenantId,
        cloudConnectionId: connection.id,
        replace: false,
        definitions: [{
          compartmentId: 'e2e-compartment', namespace: 'oci_computeagent', metricName: 'CpuUtilization',
          resourceId: dimensions.resourceId, regionId: 'us-ashburn-1', dimensions, statistics: ['MEAN', 'MAX'], unit: 'Percent',
        }],
      });

      const saved = await prisma.cloudMetricDefinition.findFirstOrThrow({
        where: { tenantId, cloudConnectionId: connection.id, metricName: 'CpuUtilization' },
      });
      expect(await prisma.cloudMetricDefinition.count({ where: { tenantId, cloudConnectionId: connection.id } })).toBe(1);
      expect(saved).toMatchObject({
        namespace: 'oci_computeagent', compartmentId: 'e2e-compartment', regionId: 'us-ashburn-1',
        externalResourceId: dimensions.resourceId, dimensions, statistics: ['MEAN', 'MAX'], enabled: true,
        status: 'CONFIRMED', discoverySource: 'OCI_LIST_METRICS',
      });
      expect(saved.dimensionsHash).toHaveLength(64);
      const ingestionConnection = await new PrismaCloudCredentialRepository(prisma)
        .getIngestionConnectionForTenant(tenantId, connection.id);
      expect(ingestionConnection?.metadata?.['ociMetricDefinitions']).toEqual([
        expect.objectContaining({
          compartmentId: 'e2e-compartment', metricName: 'CpuUtilization', resourceId: dimensions.resourceId,
          regionId: 'us-ashburn-1', dimensions, statistics: ['MEAN', 'MAX'],
        }),
      ]);
    } finally {
      await cleanupE2eFixtures(prisma, runId);
      await prisma.$disconnect();
    }
  }, 30_000);
});
