import type {
  IProcessHeartbeatRepository,
  ProcessHeartbeatRecord,
  UpsertProcessHeartbeatInput,
} from '../../domain/interfaces/IProcessHeartbeatRepository.js';
import type { MetricsRegistry } from '../observability/MetricsRegistry.js';

const DEFAULT_STALE_AFTER_MS = 90_000;
const MAX_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Persists bounded process liveness without putting operational state in a tenant. */
export class ProcessHeartbeatService {
  private readonly staleAfterMs: number;

  public constructor(
    private readonly repository: IProcessHeartbeatRepository,
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    private readonly metricsRegistry?: MetricsRegistry,
  ) {
    const normalized = Number.isFinite(staleAfterMs) ? Math.trunc(staleAfterMs) : DEFAULT_STALE_AFTER_MS;
    this.staleAfterMs = Math.min(MAX_STALE_AFTER_MS, Math.max(1_000, normalized));
  }

  public async record(input: UpsertProcessHeartbeatInput): Promise<void> {
    const startedAt = performance.now();
    try {
      await this.repository.upsert(input);
      this.metricsRegistry?.increment('process_heartbeat_writes_total', { process_role: input.processRole, outcome: 'success' });
    } catch (error) {
      this.metricsRegistry?.increment('process_heartbeat_writes_total', { process_role: input.processRole, outcome: 'failure' });
      throw error;
    } finally {
      this.metricsRegistry?.observe('process_heartbeat_write_duration_ms', performance.now() - startedAt, {
        process_role: input.processRole,
      });
    }
  }

  public async stop(processId: string, stoppedAt = new Date()): Promise<boolean> {
    const stopped = await this.repository.markStopped(processId, stoppedAt);
    this.metricsRegistry?.increment('process_heartbeat_stops_total', { outcome: stopped ? 'success' : 'missing' });
    return stopped;
  }

  public async isFresh(processId: string, now = new Date()): Promise<boolean> {
    const heartbeat = await this.repository.findById(processId);
    return heartbeat !== null && isFreshHeartbeat(heartbeat, now, this.staleAfterMs);
  }
}

export function isFreshHeartbeat(
  heartbeat: ProcessHeartbeatRecord,
  now: Date,
  staleAfterMs: number,
): boolean {
  return heartbeat.status === 'RUNNING'
    && now.getTime() - heartbeat.lastHeartbeatAt.getTime() <= staleAfterMs;
}
