import type { ProcessRole } from '../infrastructure/config/runtimeConfigTypes.js';

export interface ProcessRoleCapabilities {
  readonly runsApi: boolean;
  readonly runsIngestionWorker: boolean;
  readonly runsLearningWorker: boolean;
  readonly runsRecommendationAnalysisWorker: boolean;
  readonly runsSavingsReconciliationWorker: boolean;
  readonly runsIngestionScheduler: boolean;
  readonly runsRecommendationAnalysisScheduler: boolean;
  readonly runsNotificationScheduler: boolean;
  readonly runsAuthCleanupScheduler: boolean;
}

const apiOnly: ProcessRoleCapabilities = {
  runsApi: true,
  runsIngestionWorker: false,
  runsLearningWorker: false,
  runsRecommendationAnalysisWorker: false,
  runsSavingsReconciliationWorker: false,
  runsIngestionScheduler: false,
  runsRecommendationAnalysisScheduler: false,
  runsNotificationScheduler: false,
  runsAuthCleanupScheduler: false,
};

const workerOnly: ProcessRoleCapabilities = {
  ...apiOnly,
  runsApi: false,
  runsIngestionWorker: true,
  runsLearningWorker: true,
  runsRecommendationAnalysisWorker: true,
  runsSavingsReconciliationWorker: true,
};

const schedulerOnly: ProcessRoleCapabilities = {
  ...apiOnly,
  runsApi: false,
  runsIngestionScheduler: true,
  runsRecommendationAnalysisScheduler: true,
  runsSavingsReconciliationWorker: true,
  runsNotificationScheduler: true,
  runsAuthCleanupScheduler: true,
};

const allCapabilities: ProcessRoleCapabilities = {
  ...apiOnly,
  runsIngestionWorker: true,
  runsLearningWorker: true,
  runsRecommendationAnalysisWorker: true,
  runsSavingsReconciliationWorker: true,
  runsIngestionScheduler: true,
  runsRecommendationAnalysisScheduler: true,
  runsNotificationScheduler: true,
  runsAuthCleanupScheduler: true,
};

const granularCapabilities: Readonly<Record<Exclude<ProcessRole, 'api' | 'worker' | 'scheduler' | 'all'>, ProcessRoleCapabilities>> = {
  'ingestion-worker': { ...apiOnly, runsApi: false, runsIngestionWorker: true },
  'learning-worker': { ...apiOnly, runsApi: false, runsLearningWorker: true },
  'recommendation-analysis-worker': { ...apiOnly, runsApi: false, runsRecommendationAnalysisWorker: true },
  'savings-reconciliation-worker': { ...apiOnly, runsApi: false, runsSavingsReconciliationWorker: true },
  'ingestion-scheduler': { ...apiOnly, runsApi: false, runsIngestionScheduler: true },
  'recommendation-analysis-scheduler': { ...apiOnly, runsApi: false, runsRecommendationAnalysisScheduler: true },
  'notification-scheduler': { ...apiOnly, runsApi: false, runsNotificationScheduler: true },
  'auth-cleanup-scheduler': { ...apiOnly, runsApi: false, runsAuthCleanupScheduler: true },
};

export function resolveProcessRoleCapabilities(role: ProcessRole): ProcessRoleCapabilities {
  if (role === 'api') return apiOnly;
  if (role === 'worker') return workerOnly;
  if (role === 'scheduler') return schedulerOnly;
  if (role === 'all') return allCapabilities;
  return granularCapabilities[role];
}
