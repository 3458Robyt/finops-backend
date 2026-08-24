import 'dotenv/config';

import { createTenantAwarePool, runWithDatabaseContext } from '../../src/infrastructure/database/tenantContext.js';

const connectionString = process.env['DATABASE_URL'];
if (connectionString === undefined || connectionString.trim() === '') {
  throw new Error('DATABASE_URL is required for the runtime RLS canary.');
}
if (process.env['DB_RUNTIME_ENFORCE'] !== 'true') {
  throw new Error('DB_RUNTIME_ENFORCE=true is required for the runtime RLS canary.');
}
if (process.env['DB_RUNTIME_ROLE'] !== 'finops_runtime') {
  throw new Error('DB_RUNTIME_ROLE=finops_runtime is required for the runtime RLS canary.');
}

const tableNames = [
  'cloud_connections',
  'cloud_resources',
  'resource_metric_samples',
  'cost_metrics',
  'recommendations',
  'recommendation_decisions',
  'budgets',
  'cost_allocation_rules',
  'cost_allocation_closures',
  'cost_allocation_closure_lines',
  'ingestion_jobs',
  'recommendation_analysis_runs',
  'recommendation_savings_measurements',
  'client_invitations',
  'telegram_link_codes',
  'auth_sessions',
  'auth_refresh_tokens',
  'password_reset_tokens',
  'user_mfa',
  'mfa_challenges',
  'mfa_recovery_codes',
] as const;

const pool = createTenantAwarePool(connectionString);

try {
  const master = await runWithDatabaseContext(
    { userId: 'runtime-rls-canary', role: 'MASTER_ADMIN' },
    async () => {
      const session = await pool.query<{ current_user: string; tenant_id: string | null; worker_id: string | null }>(
        `select current_user, current_setting('app.tenant_id', true) as tenant_id,
                current_setting('app.worker_id', true) as worker_id`,
      );
      const tenants = await pool.query<{ id: string }>('select id from tenants order by id limit 2');
      return { session: session.rows[0], tenantIds: tenants.rows.map((row) => row.id) };
    },
  );

  if (master.tenantIds.length < 2) {
    throw new Error(`At least two tenants are required to prove isolation; found ${master.tenantIds.length}.`);
  }

  const tenantChecks = [];
  for (const tenantId of master.tenantIds) {
    const check = await runWithDatabaseContext(
      { tenantId, userId: 'runtime-rls-canary', role: 'ADMIN', workerId: 'runtime-rls-canary-worker' },
      async () => {
        const session = await pool.query<{ current_user: string; tenant_id: string; worker_id: string }>(
          `select current_user, current_setting('app.tenant_id', true) as tenant_id,
                  current_setting('app.worker_id', true) as worker_id`,
        );
        const counts: Record<string, number> = {};
        for (const tableName of tableNames) {
          const result = await pool.query<{ count: number }>(
            `select count(*)::int as count from "${tableName}"`,
          );
          counts[tableName] = result.rows[0]?.count ?? 0;
        }
        const otherTenant = master.tenantIds.find((candidate) => candidate !== tenantId);
        const crossTenant = await pool.query<{ count: number }>(
          'select count(*)::int as count from recommendations where tenant_id = $1',
          [otherTenant],
        );
        return {
          tenantId,
          session: session.rows[0],
          counts,
          crossTenantRecommendationCount: crossTenant.rows[0]?.count ?? 0,
        };
      },
    );
    tenantChecks.push(check);
  }

  const unscoped = await runWithDatabaseContext(
    { userId: 'runtime-rls-canary', role: 'ADMIN' },
    () => pool.query<{ count: number }>('select count(*)::int as count from recommendations'),
  );

  const failures = [
    master.session?.current_user !== 'finops_runtime' ? 'master session did not use finops_runtime' : undefined,
    ...tenantChecks.flatMap((check) => [
      check.session?.current_user !== 'finops_runtime' ? `${check.tenantId}: wrong database role` : undefined,
      check.session?.tenant_id !== check.tenantId ? `${check.tenantId}: tenant context was not applied` : undefined,
      check.session?.worker_id !== 'runtime-rls-canary-worker' ? `${check.tenantId}: worker context was not applied` : undefined,
      check.crossTenantRecommendationCount !== 0 ? `${check.tenantId}: cross-tenant recommendation rows were visible` : undefined,
    ]),
    unscoped.rows[0]?.count !== 0 ? 'unscoped recommendation rows were visible' : undefined,
  ].filter((failure): failure is string => failure !== undefined);

  const result = {
    success: failures.length === 0,
    generatedAt: new Date().toISOString(),
    runtime: {
      enforced: process.env['DB_RUNTIME_ENFORCE'],
      role: process.env['DB_RUNTIME_ROLE'],
    },
    master,
    tenantChecks,
    unscopedRecommendationCount: unscoped.rows[0]?.count ?? 0,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length > 0) {
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
