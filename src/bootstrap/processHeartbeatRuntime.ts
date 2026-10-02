import { safeErrorMessage } from '../application/observability/safeError.js';
import type { ProcessHeartbeatService } from '../application/services/ProcessHeartbeatService.js';
import type { NonOverlappingLoopOptions } from '../application/services/NonOverlappingLoop.js';
import type { RuntimeConfig } from '../infrastructure/config/runtimeConfigTypes.js';
import { runWithDatabaseContext } from '../infrastructure/database/tenantContext.js';
import { createProcessIdentity } from './processIdentity.js';

export interface ProcessHeartbeatRuntimeInput {
  readonly config: RuntimeConfig;
  readonly startBackgroundLoop: (options: NonOverlappingLoopOptions) => void;
  readonly registerStop: (stop: () => Promise<void>) => void;
}

/** Persists the liveness of the current API, worker or scheduler process. */
export async function startProcessHeartbeat(
  input: ProcessHeartbeatRuntimeInput,
  service: ProcessHeartbeatService,
): Promise<void> {
  const options = input.config.operations.processHeartbeat;
  if (!options.enabled) return;

  const startedAt = new Date();
  const processRole = input.config.environment.processRole;
  const processId = createProcessIdentity(processRole, process.env['HOSTNAME'], process.pid);
  let stopping = false;
  let lastRun = Promise.resolve();

  try {
    const reconciled = await runWithDatabaseContext(
      { workerId: 'process-heartbeat-reconciler', role: 'MASTER_ADMIN' },
      () => service.reconcileStale(startedAt),
    );
    if (reconciled > 0) {
      console.log(JSON.stringify({
        level: 'info',
        event: 'process_heartbeat_stale_reconciled',
        processId,
        stoppedCount: reconciled,
      }));
    }
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'process_heartbeat_stale_reconciliation_failed',
      processId,
      error: safeErrorMessage(error),
    }));
  }

  input.startBackgroundLoop({
    intervalMs: options.intervalMs,
    fallbackIntervalMs: Math.min(options.intervalMs, 30_000),
    run: () => {
      if (stopping) return Promise.resolve();
      const operation = runWithDatabaseContext(
        { workerId: processId, role: 'MASTER_ADMIN' },
        () => service.record({
          processId,
          processRole,
          pid: process.pid,
          startedAt,
          heartbeatAt: new Date(),
        }),
      );
      lastRun = operation.catch(() => undefined);
      return operation;
    },
    onError: (error) => console.error(JSON.stringify({
      level: 'error',
      event: 'process_heartbeat_failed',
      processId,
      error: safeErrorMessage(error),
    })),
  });

  input.registerStop(async () => {
    stopping = true;
    await lastRun;
    await runWithDatabaseContext(
      { workerId: processId, role: 'MASTER_ADMIN' },
      () => service.stop(processId),
    );
  });

  console.log(JSON.stringify({
    level: 'info',
    event: 'process_heartbeat_started',
    processId,
    processRole,
    intervalMs: options.intervalMs,
    staleAfterMs: options.staleAfterMs,
  }));
}
