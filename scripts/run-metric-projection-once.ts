import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { MetricsRegistry } from '../src/application/observability/MetricsRegistry.js';
import { PrismaMetricProjectionWorker } from '../src/infrastructure/ingestion/PrismaMetricProjectionWorker.js';

async function main(): Promise<void> {
  const prisma = getPrismaClient();
  const workerId = process.env['METRIC_PROJECTION_WORKER_ID'] ?? `manual-metric-projection-${process.pid}`;
  const worker = new PrismaMetricProjectionWorker(prisma, new MetricsRegistry(), {
    leaseMs: readPositiveInteger('METRIC_PROJECTION_LEASE_MS', 300_000),
    retryBackoffMs: readPositiveInteger('METRIC_PROJECTION_RETRY_BACKOFF_MS', 5_000),
    transactionTimeoutMs: readPositiveInteger('METRIC_PROJECTION_TRANSACTION_TIMEOUT_MS', 120_000),
  });

  try {
    console.log(JSON.stringify(await worker.processNext(workerId), null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
