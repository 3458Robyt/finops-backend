import {
  cleanupE2eFixtures,
  createTestingPrismaClient,
} from '../../src/testing/e2eFixtures.js';

const prisma = createTestingPrismaClient();

try {
  const deletedTenants = await cleanupE2eFixtures(prisma, process.env['E2E_RUN_ID']);
  console.log(JSON.stringify({
    success: true,
    deletedTenants,
    runId: process.env['E2E_RUN_ID'] ?? null,
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
