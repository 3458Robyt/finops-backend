import { describe, expect, it } from 'vitest';
import { resolveProcessRoleCapabilities } from './processRoleCapabilities.js';
import type { ProcessRole } from '../infrastructure/config/runtimeConfigTypes.js';

const workerFlags = [
  'runsIngestionWorker',
  'runsLearningWorker',
  'runsRecommendationAnalysisWorker',
  'runsSavingsReconciliationWorker',
] as const;

const schedulerFlags = [
  'runsIngestionScheduler',
  'runsRecommendationAnalysisScheduler',
  'runsNotificationScheduler',
  'runsAuthCleanupScheduler',
] as const;

describe('resolveProcessRoleCapabilities', () => {
  it('keeps the legacy worker and scheduler aliases functional', () => {
    const worker = resolveProcessRoleCapabilities('worker');
    const scheduler = resolveProcessRoleCapabilities('scheduler');

    expect(worker.runsApi).toBe(false);
    expect(workerFlags.every((flag) => worker[flag])).toBe(true);
    expect(scheduler.runsApi).toBe(false);
    expect(schedulerFlags.every((flag) => scheduler[flag])).toBe(true);
  });

  it.each([
    ['ingestion-worker', 'runsIngestionWorker'],
    ['learning-worker', 'runsLearningWorker'],
    ['recommendation-analysis-worker', 'runsRecommendationAnalysisWorker'],
    ['savings-reconciliation-worker', 'runsSavingsReconciliationWorker'],
    ['ingestion-scheduler', 'runsIngestionScheduler'],
    ['recommendation-analysis-scheduler', 'runsRecommendationAnalysisScheduler'],
    ['notification-scheduler', 'runsNotificationScheduler'],
    ['auth-cleanup-scheduler', 'runsAuthCleanupScheduler'],
  ] as const)('isolates the %s process to %s', (role, expectedFlag) => {
    const capabilities = resolveProcessRoleCapabilities(role as ProcessRole);
    const activeFlags = [...workerFlags, ...schedulerFlags].filter((flag) => capabilities[flag]);

    expect(capabilities.runsApi).toBe(false);
    expect(activeFlags).toEqual([expectedFlag]);
  });

  it('runs every capability only in all mode', () => {
    const capabilities = resolveProcessRoleCapabilities('all');

    expect(capabilities.runsApi).toBe(true);
    expect([...workerFlags, ...schedulerFlags].every((flag) => capabilities[flag])).toBe(true);
  });
});
