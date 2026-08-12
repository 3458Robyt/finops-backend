import type { Prisma } from '../../generated/prisma/client.js';

export type PrismaIngestionPersistenceClient = Pick<
  Prisma.TransactionClient,
  | 'cloudResource'
  | 'cloudAccount'
  | 'costMetric'
  | 'dataQualityCheck'
  | 'focusCostLineItem'
  | 'ingestionJob'
  | 'ingestionWatermark'
  | 'resourceMetricSample'
>;
