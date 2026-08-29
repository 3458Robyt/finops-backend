import type { ProcessHeartbeatService } from './ProcessHeartbeatService.js';
import type { RuntimeConfig } from '../../infrastructure/config/runtimeConfigTypes.js';
import type { IOperationalReadinessRepository } from '../../domain/interfaces/IOperationalReadinessRepository.js';
import { runWithDatabaseContext } from '../../infrastructure/database/tenantContext.js';

export type ReadinessCheckStatus = 'ok' | 'failed' | 'not_configured' | 'not_required';

export interface OperationalReadinessReport {
  readonly ready: boolean;
  readonly checks: {
    readonly database: ReadinessCheckStatus;
    readonly runtimeRls: ReadinessCheckStatus;
    readonly migrations: ReadinessCheckStatus;
    readonly lease: ReadinessCheckStatus;
    readonly heartbeat: ReadinessCheckStatus;
    readonly ai: ReadinessCheckStatus;
  };
}

/** Evaluates only deterministic, local readiness signals. */
export class OperationalReadinessService {
  public constructor(
    private readonly repository: IOperationalReadinessRepository,
    private readonly processHeartbeatService: ProcessHeartbeatService,
    private readonly config: RuntimeConfig,
    private readonly processId: string,
  ) {}

  public async check(): Promise<OperationalReadinessReport> {
    let snapshot;
    try {
      snapshot = await this.repository.inspect(this.config.database.expectedMigration);
    } catch {
      return this.failedReport('failed');
    }

    const database: ReadinessCheckStatus = snapshot.currentUser === undefined ? 'failed' : 'ok';
    const runtimeRls: ReadinessCheckStatus = !this.config.database.runtimeEnforce
      ? 'not_required'
      : snapshot.currentUser === this.config.database.runtimeRole ? 'ok' : 'failed';
    const migrations: ReadinessCheckStatus = snapshot.migrations.failedMigrations > 0
      || snapshot.migrations.expectedMigrationApplied === false
      ? 'failed'
      : snapshot.migrations.expectedMigrationApplied === undefined ? 'not_configured' : 'ok';
    const lease: ReadinessCheckStatus = snapshot.leaseAcquirable ? 'ok' : 'failed';
    const heartbeat = await this.heartbeatStatus();
    const ai: ReadinessCheckStatus = this.config.ai.apiKey === undefined ? 'not_configured' : 'ok';
    const checks = { database, runtimeRls, migrations, lease, heartbeat, ai };

    return {
      ready: Object.values(checks).every((status) => status !== 'failed'),
      checks,
    };
  }

  private async heartbeatStatus(): Promise<ReadinessCheckStatus> {
    if (!this.config.operations.processHeartbeat.enabled) return 'not_required';
    const isFresh = await runWithDatabaseContext(
      { workerId: this.processId, role: 'MASTER_ADMIN' },
      () => this.processHeartbeatService.isFresh(this.processId),
    );
    return isFresh
      ? 'ok'
      : 'failed';
  }

  private failedReport(database: ReadinessCheckStatus): OperationalReadinessReport {
    return {
      ready: false,
      checks: {
        database,
        runtimeRls: 'failed',
        migrations: 'failed',
        lease: 'failed',
        heartbeat: 'failed',
        ai: this.config.ai.apiKey === undefined ? 'not_configured' : 'ok',
      },
    };
  }
}
