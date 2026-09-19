import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import {
  buildIngestionReadinessSummary,
  isConfigured,
  isValidCredentialEncryptionKey,
} from '../src/infrastructure/ingestion/ingestionReadiness.js';
import type { IngestionReadinessIssue } from '../src/domain/interfaces/ICloudConnectionRepository.js';
import { runWithDatabaseContext } from '../src/infrastructure/database/tenantContext.js';

async function main(): Promise<void> {
  const prisma = getPrismaClient();
  const connections = await runWithDatabaseContext(
    { workerId: 'ingestion-readiness-cli', role: 'MASTER_ADMIN' },
    () => prisma.cloudConnection.findMany({
      where: {
        providerCode: { in: ['aws', 'oci'] },
        status: 'ACTIVE',
      },
      orderBy: [{ providerCode: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        name: true,
        providerCode: true,
        defaultRegion: true,
        lastValidatedAt: true,
        lastValidationAttemptAt: true,
        metadata: true,
        metricDefinitions: { where: { enabled: true }, select: { id: true } },
        credentials: {
          where: { status: 'ACTIVE' },
          select: { purpose: true },
        },
        ingestionJobs: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            sourceType: true,
            status: true,
            targetStart: true,
            targetEnd: true,
            errorMessage: true,
            resultSummary: true,
            completedAt: true,
          },
        },
      },
    }),
  );

  const globalIssues = buildGlobalIssues();
  const readiness = buildIngestionReadinessSummary({
    generatedAt: new Date(),
    globalIssues,
    connections: connections.map((connection) => ({
      id: connection.id,
      name: connection.name,
      providerCode: connection.providerCode,
      defaultRegion: connection.defaultRegion,
      lastValidatedAt: connection.lastValidatedAt,
      lastValidationAttemptAt: connection.lastValidationAttemptAt,
      metadata: connection.metadata,
      configuredMetricDefinitionCount: connection.metricDefinitions.length,
      credentialPurposes: connection.credentials.map((credential) => credential.purpose),
      recentJobs: connection.ingestionJobs.map((job) => ({
        id: job.id,
        sourceType: job.sourceType,
        status: job.status,
        targetStart: job.targetStart,
        targetEnd: job.targetEnd,
        completedAt: job.completedAt,
        errorMessage: job.errorMessage,
        resultSummary: job.resultSummary,
      })),
    })),
  });

  console.log(JSON.stringify(readiness, null, 2));

  await prisma.$disconnect();
}

function buildGlobalIssues(): readonly IngestionReadinessIssue[] {
  const issues: IngestionReadinessIssue[] = [];
  if (!isConfigured(process.env['DATABASE_URL'])) {
    issues.push({ provider: 'global', severity: 'BLOCKER', capability: 'CONNECTION', message: 'DATABASE_URL is not configured.', affectedData: ['Persistencia FinOps'], action: 'Configura DATABASE_URL y vuelve a ejecutar el diagnóstico.', actionCode: 'CREATE_CONNECTION' });
  }
  if (!isValidCredentialEncryptionKey(process.env['CREDENTIAL_ENCRYPTION_KEY'])) {
    issues.push({
      provider: 'global',
      severity: 'BLOCKER',
      capability: 'CREDENTIALS',
      message: 'CREDENTIAL_ENCRYPTION_KEY is missing or is not a 32-byte base64 key.',
      affectedData: ['Credenciales cloud'],
      action: 'Configura una clave base64 de 32 bytes antes de gestionar credenciales.',
      actionCode: 'CONFIGURE_CREDENTIALS',
    });
  }

  return issues;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
