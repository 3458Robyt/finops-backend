export interface OciMetricDefinition {
  readonly compartmentId: string;
  readonly namespace: string;
  readonly metricName: string;
  readonly resourceId: string;
  readonly regionId?: string;
  readonly dimensions?: Readonly<Record<string, string>>;
  readonly query?: string;
  readonly statistics?: readonly import('../../../domain/interfaces/ICloudIngestionProvider.js').MetricStatistic[];
  readonly unit?: string;
}

export interface OciFocusReportObject {
  readonly namespaceName: string;
  readonly bucketName: string;
  readonly objectName: string;
  readonly focusVersion: string;
  readonly sizeBytes?: number;
  readonly lastModified?: Date;
}

export interface OciFocusReportLocation {
  readonly namespaceName: string;
  readonly bucketName: string;
  readonly prefix: string;
  readonly focusVersion: string;
  readonly maxObjects: number;
}

export interface OciMonitoringClient {
  close?(): void;
  listMetrics(request: unknown): Promise<{
    readonly items?: readonly OciMetricStream[];
    readonly opcNextPage?: string;
  }>;
  summarizeMetricsData(request: unknown): Promise<{
    readonly items?: readonly OciSummarizedMetric[];
    readonly summarizedMetricsData?: readonly OciSummarizedMetric[];
  }>;
}

export interface OciMetricStream {
  readonly namespace?: string;
  readonly name?: string;
  readonly compartmentId?: string;
  readonly dimensions?: Readonly<Record<string, string>>;
  readonly unit?: string;
}

export interface OciSummarizedMetric {
  readonly namespace?: string;
  readonly name?: string;
  readonly dimensions?: Record<string, string>;
  readonly aggregatedDatapoints?: readonly {
    readonly timestamp?: Date | string;
    readonly value?: number;
  }[];
}

export interface OciObjectStorageClient {
  close?(): void;
  getObject(request: unknown): Promise<{
    readonly getObjectBody?: unknown;
    readonly value?: unknown;
  }>;
  listObjects(request: unknown): Promise<{
    readonly listObjects?: {
      readonly objects?: readonly {
        readonly name?: string;
        readonly size?: number;
        readonly timeModified?: Date;
      }[];
      readonly nextStartWith?: string;
    };
  }>;
}

export interface OciComputeClient {
  close?(): void;
  listInstances(request: unknown): Promise<{
    readonly items?: readonly OciComputeInstance[];
    readonly opcNextPage?: string;
  }>;
}

export interface OciIdentityClient {
  close?(): void;
  getUser(request: unknown): Promise<unknown>;
  listRegionSubscriptions(request: unknown): Promise<{
    readonly items?: readonly {
      readonly regionName?: string;
      readonly regionKey?: string;
      readonly status?: string;
    }[];
  }>;
  listCompartments(request: unknown): Promise<{
    readonly items?: readonly OciCompartment[];
    readonly opcNextPage?: string;
  }>;
}

export interface OciCompartment {
  readonly id?: string;
  readonly lifecycleState?: string;
}

export interface OciUsageClient {
  close?(): void;
  requestSummarizedUsages(request: unknown): Promise<{
    readonly opcNextPage?: string;
    readonly usageAggregation?: {
      readonly items?: readonly {
        readonly service?: string;
        readonly timeUsageStarted?: Date | string;
        readonly timeUsageEnded?: Date | string;
        readonly computedAmount?: number;
        readonly currency?: string;
        readonly computedQuantity?: number;
        readonly unit?: string;
        readonly resourceId?: string;
        readonly resourceName?: string;
        readonly region?: string;
        readonly compartmentId?: string;
        readonly skuName?: string;
        readonly skuPartNumber?: string;
      }[];
    };
  }>;
}

export interface OciComputeInstance {
  readonly id?: string;
  readonly displayName?: string;
  readonly lifecycleState?: string;
  readonly region?: string;
  readonly shape?: string;
  readonly freeformTags?: Readonly<Record<string, unknown>>;
  readonly definedTags?: Readonly<Record<string, unknown>>;
}

export interface OciResourceSearchClient {
  close?(): void;
  searchResources(request: unknown): Promise<{
    readonly opcNextPage?: string;
    readonly resourceSummaryCollection?: {
      readonly items?: readonly OciResourceSearchSummary[];
    };
  }>;
}

export interface OciResourceSearchSummary {
  readonly resourceType: string;
  readonly identifier: string;
  readonly compartmentId: string;
  readonly timeCreated?: Date | string;
  readonly displayName?: string;
  readonly availabilityDomain?: string;
  readonly lifecycleState?: string;
  readonly freeformTags?: Readonly<Record<string, unknown>>;
  readonly definedTags?: Readonly<Record<string, unknown>>;
  readonly additionalDetails?: Readonly<Record<string, unknown>>;
}
