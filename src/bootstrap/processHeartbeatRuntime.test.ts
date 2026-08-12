import { describe, expect, it } from 'vitest';
import { ProcessHeartbeatService } from '../application/services/ProcessHeartbeatService.js';
import type { IProcessHeartbeatRepository } from '../domain/interfaces/IProcessHeartbeatRepository.js';
import type { RuntimeConfig } from '../infrastructure/config/runtimeConfigTypes.js';
import type { NonOverlappingLoopOptions } from '../application/services/NonOverlappingLoop.js';
import { startProcessHeartbeat } from './processHeartbeatRuntime.js';

class FakeHeartbeatRepository implements IProcessHeartbeatRepository {
  public recorded: string[] = [];
  public stopped: string[] = [];

  public async upsert(input: Parameters<IProcessHeartbeatRepository['upsert']>[0]): Promise<void> {
    this.recorded.push(input.processId);
  }

  public async markStopped(processId: string): Promise<boolean> {
    this.stopped.push(processId);
    return true;
  }

  public async findById(_processId: string): Promise<null> {
    return null;
  }
}

function config(enabled: boolean): RuntimeConfig {
  return {
    environment: { nodeEnv: 'test', isProduction: false, processRole: 'worker' },
    operations: { processHeartbeat: { enabled, intervalMs: 30_000, staleAfterMs: 90_000 } },
  } as RuntimeConfig;
}

describe('startProcessHeartbeat', () => {
  it('records liveness immediately and marks the process stopped during shutdown', async () => {
    const repository = new FakeHeartbeatRepository();
    const service = new ProcessHeartbeatService(repository);
    let loop: NonOverlappingLoopOptions | undefined;
    let stop: (() => Promise<void>) | undefined;

    startProcessHeartbeat({
      config: config(true),
      startBackgroundLoop: (options) => { loop = options; },
      registerStop: (callback) => { stop = callback; },
    }, service);

    expect(loop).toBeDefined();
    expect(stop).toBeDefined();
    await loop!.run();
    expect(repository.recorded).toHaveLength(1);
    await stop!();
    expect(repository.stopped).toEqual(repository.recorded);
  });

  it('does not create a loop when the operational flag is disabled', () => {
    const repository = new FakeHeartbeatRepository();
    let started = false;

    startProcessHeartbeat({
      config: config(false),
      startBackgroundLoop: () => { started = true; },
      registerStop: () => { started = true; },
    }, new ProcessHeartbeatService(repository));

    expect(started).toBe(false);
  });
});
