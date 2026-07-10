import {
  createE2eFixtures,
  createTestingPrismaClient,
  writeFixtureManifest,
} from '../../src/testing/e2eFixtures.js';

const prisma = createTestingPrismaClient();

try {
  const manifest = await createE2eFixtures(prisma);
  await writeFixtureManifest(manifest);
  console.log(JSON.stringify({
    success: true,
    runId: manifest.runId,
    fixtureFile: process.env['E2E_FIXTURE_FILE'] ?? '.test-artifacts/e2e-fixtures.json',
    email: manifest.admin.email,
    tenantCount: manifest.tenants.length,
    recommendationCount: manifest.recommendationIds.length,
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
