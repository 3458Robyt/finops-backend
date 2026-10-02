import { readFileSync } from 'node:fs';
import { getPrismaClient } from '../infrastructure/database/prisma.js';
import { Argon2PasswordHasher } from '../infrastructure/security/Argon2PasswordHasher.js';

interface BootstrapInput {
  readonly tenantSlug: string;
  readonly email: string;
  readonly name: string;
  readonly temporaryPassword: string;
}

export function parseBootstrapInput(raw: string, env: NodeJS.ProcessEnv): BootstrapInput {
  validateBootstrapEnvironment(env);

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Input must be valid JSON.');
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Input must be a JSON object.');
  }

  const input = value as Record<string, unknown>;
  const tenantSlug = readRequiredString(input, 'tenantSlug').toLowerCase();
  const email = readRequiredString(input, 'email').toLowerCase();
  const name = readRequiredString(input, 'name');
  const temporaryPassword = readRequiredString(input, 'temporaryPassword', false);

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tenantSlug)) throw new Error('tenantSlug is invalid.');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('email is invalid.');
  if (name.length < 2 || name.length > 120) throw new Error('name must contain 2 to 120 characters.');
  if (temporaryPassword.length < 20 || temporaryPassword.length > 256 || /^\s+$/.test(temporaryPassword)) {
    throw new Error('temporaryPassword must contain at least 20 characters.');
  }

  assertBootstrapDatabase(env['BETA_BOOTSTRAP_DATABASE_URL'] ?? '', env);
  return { tenantSlug, email, name, temporaryPassword };
}

export function validateBootstrapEnvironment(env: NodeJS.ProcessEnv): void {
  if (env['NODE_ENV'] !== 'production') throw new Error('Bootstrap is only allowed in production beta runtime.');
  if (env['BETA_MASTER_ADMIN_BOOTSTRAP_ENABLED'] !== 'true') throw new Error('One-time bootstrap is not enabled.');
  if (env['MFA_REQUIRED_FOR_PRIVILEGED'] !== 'true') throw new Error('Privileged-user MFA must be required.');
  if (env['BETA_BOOTSTRAP_EXPECTED_DATABASE']?.trim() === undefined
    || env['BETA_BOOTSTRAP_EXPECTED_DATABASE'].trim() === '') {
    throw new Error('Expected beta database is not configured.');
  }
  if (env['BETA_BOOTSTRAP_DATABASE_URL']?.trim() === undefined
    || env['BETA_BOOTSTRAP_DATABASE_URL'].trim() === '') {
    throw new Error('Privileged bootstrap database connection is not configured.');
  }
}

function assertBootstrapDatabase(databaseUrl: string, env: NodeJS.ProcessEnv): void {
  let target: URL;
  let runtime: URL;
  try {
    target = new URL(databaseUrl);
    runtime = new URL(env['DATABASE_URL'] ?? '');
  } catch {
    throw new Error('Database connection settings are invalid.');
  }

  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !['postgres:', 'postgresql:'].includes(runtime.protocol)) {
    throw new Error('Database connection settings are invalid.');
  }

  const targetName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  const runtimeName = decodeURIComponent(runtime.pathname.replace(/^\//, ''));
  if (targetName !== env['BETA_BOOTSTRAP_EXPECTED_DATABASE']?.trim()
    || targetName !== runtimeName
    || target.hostname !== runtime.hostname
    || target.port !== runtime.port
    || target.username === runtime.username) {
    throw new Error('Bootstrap database must be the configured beta database, using a separate privileged login.');
  }
}

function readRequiredString(input: Record<string, unknown>, key: string, trim = true): string {
  const value = input[key];
  if (typeof value !== 'string' || (trim ? value.trim() === '' : value === '')) {
    throw new Error(`${key} is required.`);
  }
  return trim ? value.trim() : value;
}

async function main(): Promise<void> {
  if (process.stdin.isTTY) throw new Error('Provide the secret JSON through protected stdin; never use command arguments.');
  const input = parseBootstrapInput(readFileSync(0, 'utf8'), process.env);
  const prisma = getPrismaClient({
    url: process.env['BETA_BOOTSTRAP_DATABASE_URL'],
    runtimeEnforce: false,
    runtimeRole: '',
  });

  try {
    const passwordHash = await new Argon2PasswordHasher().hash(input.temporaryPassword);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(675421902184)`;
      if (await tx.user.count({ where: { role: 'MASTER_ADMIN' } }) > 0) {
        throw new Error('A master administrator already exists; bootstrap is single-use.');
      }

      const tenant = await tx.tenant.findUnique({
        where: { slug: input.tenantSlug },
        select: { id: true, status: true, operatorOrganizationId: true },
      });
      if (tenant === null || tenant.status !== 'ACTIVE') throw new Error('Active target tenant was not found.');

      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          operatorOrganizationId: tenant.operatorOrganizationId,
          email: input.email,
          name: input.name,
          passwordHash,
          role: 'MASTER_ADMIN',
          status: 'ACTIVE',
        },
        select: { id: true },
      });

      await tx.auditEvent.create({
        data: {
          tenantId: tenant.id,
          action: 'BETA_MASTER_ADMIN_BOOTSTRAPPED',
          entityType: 'User',
          entityId: user.id,
          metadata: { source: 'one_time_cli', mfaRequired: true },
        },
      });
    });
    console.log('Beta master administrator created. First login requires MFA enrollment.');
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith('bootstrap-beta-master-admin.js')) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    const safeErrors = new Set([
      'Input must be valid JSON.',
      'Input must be a JSON object.',
      'A master administrator already exists; bootstrap is single-use.',
      'Active target tenant was not found.',
      'Database connection settings are invalid.',
      'Bootstrap database must be the configured beta database, using a separate privileged login.',
      'Provide the secret JSON through protected stdin; never use command arguments.',
      'Bootstrap is only allowed in production beta runtime.',
      'One-time bootstrap is not enabled.',
      'Privileged-user MFA must be required.',
      'Expected beta database is not configured.',
      'Privileged bootstrap database connection is not configured.',
      'tenantSlug is required.',
      'email is required.',
      'name is required.',
      'temporaryPassword is required.',
      'tenantSlug is invalid.',
      'email is invalid.',
      'name must contain 2 to 120 characters.',
      'temporaryPassword must contain at least 20 characters.',
    ]);
    console.error(safeErrors.has(message) ? message : 'Bootstrap failed. No input values were logged; inspect database health and retry only after review.');
    process.exitCode = 1;
  });
}
