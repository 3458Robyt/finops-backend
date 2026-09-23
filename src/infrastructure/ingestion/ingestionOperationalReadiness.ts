import type { IngestionOperationalReadiness } from '../../domain/interfaces/ICloudConnectionRepository.js';

export interface IngestionOperationalCounts {
  readonly sourcePending: number;
  readonly sourceRunning: number;
  readonly projectionPending: number;
  readonly projectionRunning: number;
  readonly cancelRequested: number;
  readonly staleSourceRunning: number;
  readonly staleProjectionRunning: number;
  readonly oldestPendingAt: Date | null;
  readonly worker: {
    readonly processId: string;
    readonly processRole: string;
    readonly lastHeartbeatAt: Date;
  } | null;
}

export function buildIngestionOperationalReadiness(
  input: IngestionOperationalCounts,
): IngestionOperationalReadiness {
  const pending = input.sourcePending + input.projectionPending;
  const running = input.sourceRunning + input.projectionRunning;
  const staleRunning = input.staleSourceRunning + input.staleProjectionRunning;
  const workerAvailable = input.worker !== null;
  const state = staleRunning > 0
    ? 'STALE'
    : input.cancelRequested > 0
      ? 'CANCEL_REQUESTED'
      : !workerAvailable && pending > 0
        ? 'WAITING_FOR_WORKER'
        : running > 0
          ? 'RUNNING'
          : pending > 0 ? 'QUEUED' : 'IDLE';

  return {
    state,
    queue: { pending, running, cancelRequested: input.cancelRequested, staleRunning },
    ...(input.oldestPendingAt === null ? {} : { oldestPendingAt: input.oldestPendingAt }),
    worker: {
      available: workerAvailable,
      ...(input.worker === null ? {} : {
        processId: input.worker.processId,
        processRole: input.worker.processRole,
        lastHeartbeatAt: input.worker.lastHeartbeatAt,
      }),
    },
  };
}
