import 'dotenv/config';
import { Pool } from 'pg';
import { getPrismaClient } from '../../src/infrastructure/database/prisma.js';
import { runWithDatabaseContext } from '../../src/infrastructure/database/tenantContext.js';
import {
  deleteFailedBillingExportCandidates,
  dropDevelopmentSchemas,
  findExistingDevelopmentSchemas,
  findFailedBillingExportCandidates,
} from './developmentArtifactCleanup.js';

const args = parseArguments(process.argv.slice(2));
const prisma = getPrismaClient();
const databaseUrl = process.env['DATABASE_URL'];

if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('DATABASE_URL es obligatorio para ejecutar la limpieza controlada.');
}

assertApplySafety(databaseUrl, args.apply);

const pool = new Pool({
  connectionString: withoutSchema(databaseUrl),
  max: 1,
  connectionTimeoutMillis: 10_000,
});

try {
  const result = await runWithDatabaseContext(
    { role: 'MASTER_ADMIN', workerId: 'maintenance:development-artifact-cleanup' },
    async () => {
      const candidates = await findFailedBillingExportCandidates(prisma, args);
      const schemas = await findExistingDevelopmentSchemas(pool);
      const deletedJobs = args.apply
        ? await deleteFailedBillingExportCandidates(prisma, candidates)
        : 0;
      const droppedSchemas = args.apply ? await dropDevelopmentSchemas(pool, schemas) : 0;

      return {
        mode: args.apply ? 'apply' : 'dry-run',
        matchedFailedBillingExportJobs: candidates.length,
        deletedFailedBillingExportJobs: deletedJobs,
        existingDevelopmentSchemas: schemas,
        droppedDevelopmentSchemas: droppedSchemas,
        sampleJobIds: candidates.slice(0, 10).map((candidate) => candidate.id),
      };
    },
  );

  console.log(JSON.stringify({ event: 'development_artifact_cleanup', ...result }, null, 2));
} finally {
  await pool.end();
  await prisma.$disconnect();
}

interface CleanupArguments {
  readonly bucketName: string;
  readonly namespaceName: string;
  readonly tenantId?: string;
  readonly apply: boolean;
}

function parseArguments(rawArgs: readonly string[]): CleanupArguments {
  return {
    bucketName: requiredArgument(rawArgs, '--bucket'),
    namespaceName: requiredArgument(rawArgs, '--namespace'),
    ...(optionalArgument(rawArgs, '--tenant') === undefined
      ? {}
      : { tenantId: optionalArgument(rawArgs, '--tenant') }),
    apply: rawArgs.includes('--apply'),
  };
}

function requiredArgument(rawArgs: readonly string[], name: string): string {
  const value = optionalArgument(rawArgs, name);
  if (value === undefined) throw new Error(`Falta ${name}. La limpieza exige bucket y namespace explícitos.`);
  return value;
}

function optionalArgument(rawArgs: readonly string[], name: string): string | undefined {
  const inline = rawArgs.find((argument) => argument.startsWith(`${name}=`));
  if (inline !== undefined) {
    const value = inline.slice(name.length + 1).trim();
    return value === '' ? undefined : value;
  }

  const index = rawArgs.indexOf(name);
  const value = index < 0 ? undefined : rawArgs[index + 1];
  if (value !== undefined && !value.startsWith('--') && value.trim() !== '') return value.trim();

  // npm 11 consumes unknown `--key=value` options and exposes them as
  // npm_config_key instead of forwarding them to the child process. Support
  // that form so the documented npm script remains safe and usable on
  // Windows/PowerShell as well as the direct npx invocation.
  const npmConfigKey = `npm_config_${name.slice(2).replaceAll('-', '_')}`;
  const configuredValue = process.env[npmConfigKey] ?? process.env[npmConfigKey.toUpperCase()];
  return configuredValue === undefined || configuredValue.trim() === '' ? undefined : configuredValue.trim();
}

function assertApplySafety(databaseUrl: string, apply: boolean): void {
  if (!apply) return;
  if ((process.env['NODE_ENV'] ?? 'development').trim().toLowerCase() === 'production') {
    throw new Error('La limpieza de artefactos de desarrollo está bloqueada con NODE_ENV=production.');
  }

  const hostname = new URL(databaseUrl).hostname.toLowerCase();
  const localHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (!localHost && process.env['ALLOW_NONLOCAL_DEVELOPMENT_CLEANUP'] !== 'true') {
    throw new Error('La limpieza con --apply solo permite bases locales; usa ALLOW_NONLOCAL_DEVELOPMENT_CLEANUP=true de forma explícita si corresponde.');
  }
}

function withoutSchema(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.delete('schema');
  return url.toString();
}
