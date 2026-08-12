import { describe, expect, it } from 'vitest';
import { ProcessHeartbeatService } from './ProcessHeartbeatService.js';
import type { IProcessHeartbeatRepository, ProcessHeartbeatRecord } from '../../domain/interfaces/IProcessHeartbeatRepository.js';

class FakeHeartbeatRepository implements IProcessHeartbeatRepository {
  public record: ProcessHeartbeatRecord | null = null;
  public stopped = false;

  public async upsert(input: Parameters<IProcessHeartbeatRepository['upsert']>[0]): Promise<void> {
    this.record = {
      processId: input.processId,
      processRole: input.processRole,
      status: 'RUNNING',
      ...(input.pid === undefined ? {} : { pid: input.pid }),
      startedAt: input.startedAt,
      lastHeartbeatAt: input.heartbeatAt,
    };
  }

  public async markStopped(): Promise<boolean> {
    this.stopped = true;
    if (this.record !== null) this.record = { ...this.record, status: 'STOPPED' };
    return true;
  }

  public async findById(processId: string): Promise<ProcessHeartbeatRecord | null> {
    return this.record?.processId === processId ? this.record : null;
  }
}

describe('ProcessHeartbeatService', () => {
  it('records and recognizes a fresh process heartbeat', async () => {
    const repository = new FakeHeartbeatRepository();
    const service = new ProcessHeartbeatService(repository, 30_000);
    const now = new Date('2026-08-12T14:00:00.000Z');

    await service.record({ processId: 'worker-1', processRole: 'worker', pid: 42, startedAt: now, heartbeatAt: now });

    await expect(service.isFresh('worker-1', new Date(now.getTime() + 29_999))).resolves.toBe(true);
    await expect(service.stop('worker-1', new Date(now.getTime() + 1_000))).resolves.toBe(true);
    await expect(service.isFresh('worker-1', new Date(now.getTime() + 2_000))).resolves.toBe(false);
    expect(repository.stopped).toBe(true);
  });

  it('rejects missing and stale heartbeats', async () => {
    const repository = new FakeHeartbeatRepository();
    const service = new ProcessHeartbeatService(repository, 30_000);
    const startedAt = new Date('2026-08-12T14:00:00.000Z');
    await service.record({ processId: 'scheduler-1', processRole: 'scheduler', startedAt, heartbeatAt: startedAt });

    await expect(service.isFresh('unknown', startedAt)).resolves.toBe(false);
    await expect(service.isFresh('scheduler-1', new Date(startedAt.getTime() + 30_001))).resolves.toBe(false);
  });
});
