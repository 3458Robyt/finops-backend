import type { IngestionJobHistoryItem } from './ICloudConnectionRepository.js';
import type { IngestionJobStatus, IngestionSourceType } from '../models/CloudConnection.js';

export interface MasterAdminIngestionJobFilters {
  readonly tenantId?: string;
  readonly status?: IngestionJobStatus;
  readonly sourceType?: IngestionSourceType;
  readonly includeArchived: boolean;
  readonly limit: number;
}

export interface MasterAdminIngestionJob extends IngestionJobHistoryItem {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantSlug: string;
  readonly connectionName: string;
  readonly providerCode: string;
  readonly defaultRegion?: string;
  readonly requestedByUserName?: string;
  readonly requestedByUserEmail?: string;
}

export interface MasterAdminIngestionJobSummary {
  readonly total: number;
  readonly pending: number;
  readonly running: number;
  readonly success: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly skipped: number;
}

export interface MasterAdminIngestionJobPage {
  readonly jobs: readonly MasterAdminIngestionJob[];
  readonly summary: MasterAdminIngestionJobSummary;
  readonly hasMore: boolean;
}

export interface DeletedPendingIngestionJobs {
  readonly deletedCount: number;
  readonly byTenant: readonly { readonly tenantId: string; readonly count: number }[];
}

export interface ReconciledIngestionJobs {
  readonly requeued: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface IMasterAdminIngestionJobRepository {
  list(input: MasterAdminIngestionJobFilters): Promise<MasterAdminIngestionJobPage>;
  deletePendingJobs(): Promise<DeletedPendingIngestionJobs>;
  reconcileStaleJobs?: () => Promise<ReconciledIngestionJobs>;
  requestCancellation(jobId: string, userId: string): Promise<MasterAdminIngestionJob | null>;
  archive(jobId: string, userId: string): Promise<MasterAdminIngestionJob | null>;
}
