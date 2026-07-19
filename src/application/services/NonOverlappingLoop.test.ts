import { describe, expect, it, vi } from 'vitest';
import { startNonOverlappingLoop } from './NonOverlappingLoop.js';

describe('startNonOverlappingLoop', () => {
  it('runs immediately and schedules future iterations', () => {
    const run = vi.fn(async () => ({ processed: false }));
    const setIntervalFn = vi.fn(() => 123 as unknown as NodeJS.Timeout);
    const clearIntervalFn = vi.fn();

    const handle = startNonOverlappingLoop({
      run,
      intervalMs: 5000,
      fallbackIntervalMs: 30000,
      setIntervalFn,
      clearIntervalFn,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 5000);

    handle.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(123);
  });

  it('skips overlapping iterations while a previous run is still active', async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<{ readonly processed: boolean }>((resolve) => {
      release = () => resolve({ processed: false });
    }));
    const onSkip = vi.fn();
    let scheduled!: () => void;

    startNonOverlappingLoop({
      run,
      intervalMs: 1000,
      fallbackIntervalMs: 30000,
      setIntervalFn: ((callback: () => void) => {
        scheduled = callback;
        return 123 as unknown as NodeJS.Timeout;
      }) as typeof setInterval,
      clearIntervalFn: vi.fn(),
      onSkip,
    });

    scheduled();

    expect(run).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);

    release();
    await Promise.resolve();
    await Promise.resolve();

    scheduled();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reports errors and continues future iterations', async () => {
    const onError = vi.fn();
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ processed: false });
    let scheduled!: () => void;

    startNonOverlappingLoop({
      run,
      intervalMs: 1000,
      fallbackIntervalMs: 30000,
      setIntervalFn: ((callback: () => void) => {
        scheduled = callback;
        return 123 as unknown as NodeJS.Timeout;
      }) as typeof setInterval,
      clearIntervalFn: vi.fn(),
      onError,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(expect.any(Error));

    scheduled();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
