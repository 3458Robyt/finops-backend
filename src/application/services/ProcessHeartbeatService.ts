import type {
  IProcessHeartbeatRepository,
  ProcessHeartbeatRecord,
  UpsertProcessHeartbeatInput,
} from '../../domain/interfaces/IProcessHeartbeatRepository.js';

const DEFAULT_STALE_AFTER_MS = 90_000;
const MAX_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Persists bounded process liveness without putting operational state in a tenant. */
export class ProcessHeartbeatService {
  private readonly staleAfterMs: number;

  public constructor(
    private readonly repository: IProcessHeartbeatRepository,
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
  ) {
    const normalized = Number.isFinite(staleAfterMs) ? Math.trunc(staleAfterMs) : DEFAULT_STALE_AFTER_MS;
    this.staleAfterMs = Math.min(MAX_STALE_AFTER_MS, Math.max(1_000, normalized));
  }

  public record(input: UpsertProcessHeartbeatInput): Promise<void> {
    return this.repository.upsert(input);
  }

  public stop(processId: string, stoppedAt = new Date()): Promise<boolean> {
    return this.repository.markStopped(processId, stoppedAt);
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
