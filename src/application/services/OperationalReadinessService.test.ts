import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../observability/MetricsRegistry.js';
import { ProcessHeartbeatService } from './ProcessHeartbeatService.js';
import { OperationalReadinessService } from './OperationalReadinessService.js';
import type {
  IOperationalReadinessRepository,
  OperationalReadinessSnapshot,
} from '../../domain/interfaces/IOperationalReadinessRepository.js';
import type { IProcessHeartbeatRepository } from '../../domain/interfaces/IProcessHeartbeatRepository.js';
import type { RuntimeConfig } from '../../infrastructure/config/runtimeConfigTypes.js';
import { getDatabaseContext } from '../../infrastructure/database/tenantContext.js';

const processId = 'finops:api:test:42';
const expectedMigration = '202608120005_runtime_process_heartbeats';

class FakeReadinessRepository implements IOperationalReadinessRepository {
  public snapshot: OperationalReadinessSnapshot = {
    currentUser: 'finops_runtime',
    migrations: {
      expectedMigration,
      latestAppliedMigration: expectedMigration,
      failedMigrations: 0,
      expectedMigrationApplied: true,
    },
    leaseAcquirable: true,
  };

  public async inspect(): Promise<OperationalReadinessSnapshot> {
    return this.snapshot;
  }
}

class FakeHeartbeatRepository implements IProcessHeartbeatRepository {
  public lastHeartbeat = new Date();
  public observedWorkerId: string | undefined;

  public async upsert(input: Parameters<IProcessHeartbeatRepository['upsert']>[0]): Promise<void> {
    this.lastHeartbeat = input.heartbeatAt;
  }

  public async markStopped(): Promise<boolean> { return true; }

  public async findById(id: string) {
    this.observedWorkerId = getDatabaseContext()?.workerId;
    if (id !== processId) return null;
    return {
      processId,
      processRole: 'api',
      status: 'RUNNING' as const,
      startedAt: this.lastHeartbeat,
      lastHeartbeatAt: this.lastHeartbeat,
    };
  }
}

function runtimeConfig(overrides: Partial<RuntimeConfig['database']> = {}): RuntimeConfig {
  return {
    environment: { nodeEnv: 'test', isProduction: false, processRole: 'api' },
    database: {
      url: 'postgresql://localhost/finops',
      runtimeEnforce: true,
      runtimeRole: 'finops_runtime',
      expectedMigration,
      ...overrides,
    },
    ai: { apiKey: undefined },
    operations: { processHeartbeat: { enabled: true, intervalMs: 30_000, staleAfterMs: 90_000 } },
  } as RuntimeConfig;
}

describe('OperationalReadinessService', () => {
  it('reports deterministic database, migration, lease and heartbeat readiness', async () => {
    const metrics = new MetricsRegistry();
    const heartbeatRepository = new FakeHeartbeatRepository();
    const heartbeatService = new ProcessHeartbeatService(heartbeatRepository, 90_000, metrics);
    await heartbeatService.record({
      processId,
      processRole: 'api',
      startedAt: heartbeatRepository.lastHeartbeat,
      heartbeatAt: heartbeatRepository.lastHeartbeat,
    });
    const service = new OperationalReadinessService(
      new FakeReadinessRepository(),
      heartbeatService,
      runtimeConfig(),
      processId,
    );

    await expect(service.check()).resolves.toMatchObject({
      ready: true,
      checks: {
        database: 'ok',
        runtimeRls: 'ok',
        migrations: 'ok',
        lease: 'ok',
        heartbeat: 'ok',
        ai: 'not_configured',
      },
    });
    expect(metrics.toPrometheus()).toContain('finops_process_heartbeat_writes_total');
    expect(heartbeatRepository.observedWorkerId).toBe(processId);
  });

  it('fails closed when the migration or heartbeat is stale', async () => {
    const repository = new FakeReadinessRepository();
    repository.snapshot = {
      ...repository.snapshot,
      migrations: { ...repository.snapshot.migrations, expectedMigrationApplied: false },
    };
    const heartbeatRepository = new FakeHeartbeatRepository();
    heartbeatRepository.lastHeartbeat = new Date(Date.now() - 2_000);
    const heartbeatService = new ProcessHeartbeatService(heartbeatRepository, 1_000);
    const service = new OperationalReadinessService(
      repository,
      heartbeatService,
      runtimeConfig(),
      processId,
    );

    await expect(service.check()).resolves.toMatchObject({
      ready: false,
      checks: { migrations: 'failed', heartbeat: 'failed' },
    });
  });

  it('does not require runtime role or heartbeat when explicitly disabled', async () => {
    const service = new OperationalReadinessService(
      new FakeReadinessRepository(),
      new ProcessHeartbeatService(new FakeHeartbeatRepository()),
      {
        ...runtimeConfig({ runtimeEnforce: false }),
        operations: { processHeartbeat: { enabled: false, intervalMs: 30_000, staleAfterMs: 90_000 } },
      },
      processId,
    );

    await expect(service.check()).resolves.toMatchObject({
      ready: true,
      checks: { runtimeRls: 'not_required', heartbeat: 'not_required' },
    });
  });
});
