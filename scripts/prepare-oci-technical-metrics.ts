import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { invalidatedValidationData } from '../src/infrastructure/repositories/cloudConnectionMetadata.js';
import { OCI_CORE_METRIC_STATISTICS } from '../src/domain/interfaces/ICloudIngestionProvider.js';

/**
 * Rewrites an OCI connection's technical definitions to provider-native core
 * statistics without touching encrypted credentials or existing samples.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const connectionId = args.get('connection-id');
  if (connectionId === undefined) {
    throw new Error('Pass --connection-id <id>.');
  }

  const prisma = getPrismaClient();
  const connection = await prisma.cloudConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, providerCode: true, metadata: true },
  });
  if (connection === null) throw new Error('La conexión indicada no existe.');
  if (connection.providerCode !== 'oci') throw new Error('La conexión indicada no es OCI.');

  const metadata = isRecord(connection.metadata) ? { ...connection.metadata } : {};
  const currentDefinitions = metadata['ociMetricDefinitions'];
  if (!Array.isArray(currentDefinitions) || currentDefinitions.length === 0) {
    throw new Error('La conexión no tiene ociMetricDefinitions configuradas.');
  }

  const definitions = currentDefinitions.map((definition, index) => {
    if (!isRecord(definition)) throw new Error(`La definición ${index + 1} no es un objeto.`);
    const next = { ...definition };
    delete next['query'];
    delete next['statistic'];
    next['statistics'] = [...OCI_CORE_METRIC_STATISTICS];
    return next;
  });
  metadata['ociMetricDefinitions'] = definitions;

  const dryRun = args.has('dry-run');
  if (!dryRun) {
    await prisma.cloudConnection.update({
      where: { id: connectionId },
      data: invalidatedValidationData(metadata),
    });
  }

  const metrics = [...new Set(definitions.map((definition) => String(definition['metricName'] ?? 'unknown')))].sort();
  console.log(JSON.stringify({
    success: true,
    mode: dryRun ? 'dry-run' : 'apply',
    connectionId,
    definitions: definitions.length,
    statistics: OCI_CORE_METRIC_STATISTICS,
    metrics,
    validationInvalidated: !dryRun,
  }, null, 2));
}

function parseArgs(args: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const value = args[index + 1];
    if (token?.startsWith('--') !== true) continue;
    if (value !== undefined && !value.startsWith('--')) {
      parsed.set(token.slice(2), value);
      index += 1;
    } else {
      parsed.set(token.slice(2), 'true');
    }
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
