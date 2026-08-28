import type { IngestionSourceType } from '../../domain/models/CloudConnection.js';
import type { IngestionScheduleOptions } from './ingestionJobScheduler.js';

export function getWindowMs(sourceType: IngestionSourceType, options: IngestionScheduleOptions): number {
  if (sourceType === 'INVENTORY') return (options.inventoryWindowHours ?? 24) * 60 * 60 * 1000;
  if (sourceType === 'TECHNICAL_METRIC') return options.metricWindowMinutes * 60 * 1000;
  return options.billingWindowHours * 60 * 60 * 1000;
}

export function getCooldownMs(sourceType: IngestionSourceType, options: IngestionScheduleOptions): number {
  if (sourceType === 'INVENTORY') return (options.inventoryCooldownHours ?? 24) * 60 * 60 * 1000;
  if (sourceType === 'TECHNICAL_METRIC') return options.metricCooldownMinutes * 60 * 1000;
  return options.billingCooldownHours * 60 * 60 * 1000;
}
