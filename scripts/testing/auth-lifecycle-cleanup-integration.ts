import 'dotenv/config';

import { resolve } from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { AuthLifecycleCleanupService } from '../../src/application/services/AuthLifecycleCleanupService.js';
import { PrismaAuthLifecycleCleanupRepository } from '../../src/infrastructure/repositories/PrismaAuthLifecycleCleanupRepository.js';
import { createTenantAwarePool, runWithDatabaseContext } from '../../src/infrastructure/database/tenantContext.js';
import { assertIntegrationSchema, createIntegrationPool, runIntegrationCommand } from './integrationRuntime.js';
const sourceUrl = process.env['DATABASE_URL'];
if (sourceUrl === undefined || sourceUrl.trim() === '') {
  throw new Error('DATABASE_URL is required for the isolated auth cleanup integration.');
}

const schema = `finops_e2e_auth_cleanup_${Date.now().toString(36)}`;
const isolatedUrl = withSchema(sourceUrl, schema);
const baseUrl = withoutSchema(sourceUrl);
const prismaCli = resolve('node_modules/prisma/build/index.js');
let admin: PrismaClient | undefined;
let runtime: PrismaClient | undefined;
let runtimePool: Pool | undefined;

try {
  await createSchema(baseUrl, schema);
  await runCommand(process.execPath, [prismaCli, 'migrate', 'deploy'], { DATABASE_URL: isolatedUrl });

  admin = new PrismaClient({
    adapter: new PrismaPg(createIntegrationPool(isolatedUrl, schema), { schema, disposeExternalPool: true }),
  });
  const runtimeConfig = { runtimeEnforce: true, runtimeRole: 'finops_runtime' } as const;
  runtimePool = createTenantAwarePool(isolatedUrl, schema, runtimeConfig);
  runtime = new PrismaClient({ adapter: new PrismaPg(runtimePool, { schema }) });

  // Keep the fixture relative to the database clock because the RLS cleanup
  // policy deliberately compares expiration against CURRENT_TIMESTAMP.
  const now = new Date();
  const expired = new Date(now.getTime() - 60 * 60 * 1000);
  const future = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tenant = await admin.tenant.create({ data: { name: 'Auth cleanup integration', slug: schema } });
  const user = await admin.user.create({
    data: { tenantId: tenant.id, email: `${schema}@example.test`, name: 'Cleanup Fixture', passwordHash: 'fixture' },
  });
  const expiredSession = await admin.authSession.create({
    data: { id: 'expired-session', userId: user.id, tenantId: tenant.id, jwtId: 'expired-jwt', issuedAt: expired, expiresAt: expired },
  });
  const activeSession = await admin.authSession.create({
    data: { id: 'active-session', userId: user.id, tenantId: tenant.id, jwtId: 'active-jwt', issuedAt: now, expiresAt: future },
  });
  const mismatchedSession = await admin.authSession.create({
    data: { id: 'mismatched-session', userId: user.id, tenantId: tenant.id, jwtId: 'mismatched-jwt', issuedAt: expired, expiresAt: expired },
  });
  await admin.authRefreshToken.createMany({ data: [
    { id: 'expired-refresh', sessionId: expiredSession.id, userId: user.id, tenantId: tenant.id, familyId: 'expired-family', tokenHash: 'expired-refresh-hash', issuedAt: expired, expiresAt: expired },
    { id: 'active-refresh', sessionId: activeSession.id, userId: user.id, tenantId: tenant.id, familyId: 'active-family', tokenHash: 'active-refresh-hash', issuedAt: now, expiresAt: future },
    { id: 'revoked-refresh', sessionId: activeSession.id, userId: user.id, tenantId: tenant.id, familyId: 'revoked-family', tokenHash: 'revoked-refresh-hash', issuedAt: now, expiresAt: future, revokedAt: now },
    { id: 'future-refresh-on-expired-session', sessionId: mismatchedSession.id, userId: user.id, tenantId: tenant.id, familyId: 'mismatched-family', tokenHash: 'mismatched-refresh-hash', issuedAt: expired, expiresAt: future },
  ] });
  await admin.passwordResetToken.createMany({ data: [
    { id: 'expired-reset', userId: user.id, tokenHash: 'expired-reset-hash', expiresAt: expired },
    { id: 'active-reset', userId: user.id, tokenHash: 'active-reset-hash', expiresAt: future },
  ] });
  await admin.mfaChallenge.createMany({ data: [
    { id: 'expired-challenge', userId: user.id, tokenHash: 'expired-challenge-hash', purpose: 'LOGIN', expiresAt: expired },
    { id: 'active-challenge', userId: user.id, tokenHash: 'active-challenge-hash', purpose: 'LOGIN', expiresAt: future },
  ] });

  const service = new AuthLifecycleCleanupService(new PrismaAuthLifecycleCleanupRepository(runtime), 50);
  const result = await runWithDatabaseContext(
    { role: 'MASTER_ADMIN', workerId: 'finops-maintenance:auth-lifecycle' },
    () => service.runOnce(now),
  );

  assert(result.refreshTokens === 1 && result.passwordResetTokens === 1 && result.mfaChallenges === 1 && result.sessions === 1, `Unexpected cleanup result: ${JSON.stringify(result)}`);
  const futureSessionDeletion = await runWithDatabaseContext(
    { role: 'MASTER_ADMIN', workerId: 'finops-maintenance:auth-lifecycle' },
    () => runtime!.authSession.deleteMany({ where: { id: activeSession.id } }),
  );
  assert(futureSessionDeletion.count === 0, 'The maintenance context can delete a non-expired session.');
  const [sessions, refreshTokens, resetTokens, challenges] = await Promise.all([
    admin.authSession.count(),
    admin.authRefreshToken.count(),
    admin.passwordResetToken.count(),
    admin.mfaChallenge.count(),
  ]);
  assert(sessions === 2 && refreshTokens === 3 && resetTokens === 1 && challenges === 1, 'Active and future-expiry artifacts were not preserved.');
  console.log(JSON.stringify({ status: 'PASSED', result, retained: { sessions, refreshTokens, resetTokens, challenges } }));
} finally {
  await runtime?.$disconnect();
  await admin?.$disconnect();
  await runtimePool?.end();
  await dropSchema(baseUrl, schema);
}

function withSchema(connectionString: string, schemaName: string): string {
  assertIntegrationSchema(schemaName);
  const url = new URL(connectionString);
  url.searchParams.set('schema', schemaName);
  return url.toString();
}

function withoutSchema(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.delete('schema');
  return url.toString();
}

async function createSchema(connectionString: string, schemaName: string): Promise<void> {
  assertIntegrationSchema(schemaName);
  const pool = createIntegrationPool(connectionString);
  try { await pool.query(`CREATE SCHEMA "${schemaName}"`); } finally { await pool.end(); }
}

async function dropSchema(connectionString: string, schemaName: string): Promise<void> {
  assertIntegrationSchema(schemaName);
  const pool = createIntegrationPool(connectionString);
  try { await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`); } finally { await pool.end(); }
}

async function runCommand(command: string, args: readonly string[], overrides: NodeJS.ProcessEnv): Promise<void> {
  await runIntegrationCommand(command, args, overrides);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
