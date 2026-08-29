import type { Pool } from 'pg';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

export const DEVELOPMENT_SCHEMAS = [
  'finops_e2e_integrated_secure_beta',
  'finops_e2e_local',
  'finops_e2e_verified_savings',
] as const;

export interface FailedBillingExportCandidate {
  readonly id: string;
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly targetStart: Date;
  readonly targetEnd: Date;
}

export async function findFailedBillingExportCandidates(
  prisma: PrismaClient,
  options: {
    readonly bucketName: string;
    readonly namespaceName: string;
    readonly tenantId?: string;
  },
): Promise<readonly FailedBillingExportCandidate[]> {
  const jobs = await prisma.ingestionJob.findMany({
    where: {
      sourceType: 'BILLING_EXPORT',
      status: 'FAILED',
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    },
    select: {
      id: true,
      tenantId: true,
      cloudConnectionId: true,
      targetStart: true,
      targetEnd: true,
      requestContext: true,
      cloudConnection: { select: { metadata: true } },
    },
  });

  return jobs
    .filter((job) => hasStoragePair(job.requestContext, options)
      || hasStoragePair(job.cloudConnection.metadata, options))
    .map(({ id, tenantId, cloudConnectionId, targetStart, targetEnd }) => ({
      id,
      tenantId,
      cloudConnectionId,
      targetStart,
      targetEnd,
    }));
}

export async function deleteFailedBillingExportCandidates(
  prisma: PrismaClient,
  candidates: readonly FailedBillingExportCandidate[],
): Promise<number> {
  if (candidates.length === 0) return 0;
  const result = await prisma.ingestionJob.deleteMany({
    where: {
      id: { in: candidates.map((candidate) => candidate.id) },
      sourceType: 'BILLING_EXPORT',
      status: 'FAILED',
    },
  });
  return result.count;
}

export async function findExistingDevelopmentSchemas(pool: Pool): Promise<readonly string[]> {
  const result = await pool.query<{ readonly schema_name: string }>(`
    SELECT nspname AS schema_name
    FROM pg_namespace
    WHERE nspname = ANY($1::text[])
    ORDER BY nspname
  `, [DEVELOPMENT_SCHEMAS]);
  return result.rows.map((row) => row.schema_name);
}

export async function dropDevelopmentSchemas(pool: Pool, schemas: readonly string[]): Promise<number> {
  for (const schema of schemas) {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
  }
  return schemas.length;
}

function hasStoragePair(value: unknown, options: {
  readonly bucketName: string;
  readonly namespaceName: string;
}): boolean {
  if (Array.isArray(value)) return value.some((item) => hasStoragePair(item, options));
  if (!isRecord(value)) return false;

  const bucket = readString(value, ['bucket', 'bucket_name', 'bucketName']);
  const namespace = readString(value, ['namespace', 'namespace_name', 'namespaceName']);
  if (bucket === options.bucketName && namespace === options.namespaceName) return true;

  return Object.values(value).some((item) => hasStoragePair(item, options));
}

function readString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
