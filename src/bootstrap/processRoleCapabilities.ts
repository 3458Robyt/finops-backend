import type { ProcessRole } from '../infrastructure/config/runtimeConfigTypes.js';

export interface ProcessRoleCapabilities {
  readonly runsApi: boolean;
  readonly runsIngestionWorker: boolean;
  readonly runsMetricProjectionWorker: boolean;
  readonly runsLearningWorker: boolean;
  readonly runsTelegramInboundWorker: boolean;
  readonly runsRecommendationAnalysisWorker: boolean;
  readonly runsSavingsReconciliationWorker: boolean;
  readonly runsIngestionScheduler: boolean;
  readonly runsRecommendationAnalysisScheduler: boolean;
  readonly runsNotificationScheduler: boolean;
  readonly runsAuthCleanupScheduler: boolean;
  readonly runsBudgetScheduler: boolean;
}

const apiOnly: ProcessRoleCapabilities = {
  runsApi: true,
  runsIngestionWorker: false,
  runsMetricProjectionWorker: false,
  runsLearningWorker: false,
  runsTelegramInboundWorker: false,
  runsRecommendationAnalysisWorker: false,
  runsSavingsReconciliationWorker: false,
  runsIngestionScheduler: false,
  runsRecommendationAnalysisScheduler: false,
  runsNotificationScheduler: false,
  runsAuthCleanupScheduler: false,
  runsBudgetScheduler: false,
};

const workerOnly: ProcessRoleCapabilities = {
  ...apiOnly,
  runsApi: false,
  runsIngestionWorker: true,
  runsMetricProjectionWorker: true,
  runsLearningWorker: true,
  runsTelegramInboundWorker: true,
  runsRecommendationAnalysisWorker: true,
  runsSavingsReconciliationWorker: true,
};

const schedulerOnly: ProcessRoleCapabilities = {
  ...apiOnly,
  runsApi: false,
  runsIngestionScheduler: true,
  runsRecommendationAnalysisScheduler: true,
  runsSavingsReconciliationWorker: true,
  runsTelegramInboundWorker: true,
  runsNotificationScheduler: true,
  runsAuthCleanupScheduler: true,
  runsBudgetScheduler: true,
};

const allCapabilities: ProcessRoleCapabilities = {
  ...apiOnly,
  runsIngestionWorker: true,
  runsMetricProjectionWorker: true,
  runsLearningWorker: true,
  runsTelegramInboundWorker: true,
  runsRecommendationAnalysisWorker: true,
  runsSavingsReconciliationWorker: true,
  runsIngestionScheduler: true,
  runsRecommendationAnalysisScheduler: true,
  runsNotificationScheduler: true,
  runsAuthCleanupScheduler: true,
  runsBudgetScheduler: true,
};

const granularCapabilities: Readonly<Record<Exclude<ProcessRole, 'api' | 'worker' | 'scheduler' | 'all'>, ProcessRoleCapabilities>> = {
  'ingestion-worker': { ...apiOnly, runsApi: false, runsIngestionWorker: true, runsMetricProjectionWorker: true },
  'learning-worker': { ...apiOnly, runsApi: false, runsLearningWorker: true },
  'recommendation-analysis-worker': { ...apiOnly, runsApi: false, runsRecommendationAnalysisWorker: true },
  'savings-reconciliation-worker': { ...apiOnly, runsApi: false, runsSavingsReconciliationWorker: true },
  'ingestion-scheduler': { ...apiOnly, runsApi: false, runsIngestionScheduler: true },
  'recommendation-analysis-scheduler': { ...apiOnly, runsApi: false, runsRecommendationAnalysisScheduler: true },
  'notification-scheduler': { ...apiOnly, runsApi: false, runsNotificationScheduler: true, runsTelegramInboundWorker: true },
  'auth-cleanup-scheduler': { ...apiOnly, runsApi: false, runsAuthCleanupScheduler: true },
  'budget-scheduler': { ...apiOnly, runsApi: false, runsBudgetScheduler: true },
};

export function resolveProcessRoleCapabilities(role: ProcessRole): ProcessRoleCapabilities {
  if (role === 'api') return apiOnly;
  if (role === 'worker') return workerOnly;
  if (role === 'scheduler') return schedulerOnly;
  if (role === 'all') return allCapabilities;
  return granularCapabilities[role];
}
