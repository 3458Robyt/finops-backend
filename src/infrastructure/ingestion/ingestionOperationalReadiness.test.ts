import { describe, expect, it } from 'vitest';
import { buildIngestionOperationalReadiness } from './ingestionOperationalReadiness.js';

const base = {
  sourcePending: 0,
  sourceRunning: 0,
  projectionPending: 0,
  projectionRunning: 0,
  cancelRequested: 0,
  staleSourceRunning: 0,
  staleProjectionRunning: 0,
  oldestPendingAt: null,
  worker: null,
} as const;

describe('buildIngestionOperationalReadiness', () => {
  it('counts a queued technical projection as pending and waiting for a worker', () => {
    const oldestPendingAt = new Date('2026-09-22T14:13:01.000Z');
    const readiness = buildIngestionOperationalReadiness({ ...base, projectionPending: 1, oldestPendingAt });

    expect(readiness.state).toBe('WAITING_FOR_WORKER');
    expect(readiness.queue.pending).toBe(1);
    expect(readiness.oldestPendingAt).toEqual(oldestPendingAt);
    expect(readiness.worker.available).toBe(false);
  });

  it('counts an active projection as running', () => {
    const readiness = buildIngestionOperationalReadiness({
      ...base,
      projectionRunning: 1,
      worker: { processId: 'worker-1', processRole: 'worker', lastHeartbeatAt: new Date() },
    });

    expect(readiness.state).toBe('RUNNING');
    expect(readiness.queue.running).toBe(1);
    expect(readiness.worker.processRole).toBe('worker');
  });

  it('marks a stale metric projection as stale', () => {
    const readiness = buildIngestionOperationalReadiness({ ...base, staleProjectionRunning: 1 });

    expect(readiness.state).toBe('STALE');
    expect(readiness.queue.staleRunning).toBe(1);
  });
});
