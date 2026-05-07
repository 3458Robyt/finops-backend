import type {
  CloudConnectionSummary,
  IngestionHealthSummary,
  IngestionSourceType,
  ProviderCatalogEntry,
  ProviderCode,
} from '../models/CloudConnection.js';

export interface CreateCloudConnectionInput {
  readonly tenantId: string;
  readonly providerCode: ProviderCode;
  readonly rootExternalId: string;
  readonly name: string;
  readonly defaultRegion?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CreateIngestionJobInput {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly sourceType: IngestionSourceType;
  readonly requestedByUserId?: string;
  readonly targetStart: Date;
  readonly targetEnd: Date;
  readonly maxAttempts?: number;
}

export interface IngestionJobSummary {
  readonly id: string;
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly sourceType: IngestionSourceType;
  readonly status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  readonly targetStart: Date;
  readonly targetEnd: Date;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ICloudConnectionRepository {
  listProviderCatalog(): Promise<readonly ProviderCatalogEntry[]>;
  findProviderCatalog(providerCode: string): Promise<ProviderCatalogEntry | null>;
  createCloudConnection(input: CreateCloudConnectionInput): Promise<CloudConnectionSummary>;
  findCloudConnectionForTenant(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<CloudConnectionSummary | null>;
  listCloudConnectionsForTenant(tenantId: string): Promise<readonly CloudConnectionSummary[]>;
  markCloudConnectionValidated(cloudConnectionId: string, validatedAt: Date): Promise<void>;
  createIngestionJob(input: CreateIngestionJobInput): Promise<IngestionJobSummary>;
  getIngestionHealth(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<IngestionHealthSummary | null>;
}
