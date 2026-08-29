export interface AwsMetricDefinition {
  readonly externalResourceId: string;
  readonly namespace: string;
  readonly metricName: string;
  readonly dimensions: readonly { readonly Name: string; readonly Value: string }[];
  readonly stat: string;
  readonly unit?: string;
  readonly region?: string;
}

export interface AwsFocusExportObject {
  readonly bucket: string;
  readonly key: string;
  readonly region?: string;
  readonly focusVersion: string;
  readonly sizeBytes?: number;
  readonly lastModified?: Date;
}

export interface AwsFocusExportLocation {
  readonly bucket: string;
  readonly prefix: string;
  readonly region?: string;
  readonly focusVersion: string;
  readonly maxObjects: number;
}

export interface AwsCommandClient<TResponse> {
  send(command: unknown): Promise<TResponse>;
  destroy?(): void;
}

export interface AwsAssumeRoleResponse {
  readonly Credentials?: {
    readonly AccessKeyId?: string;
    readonly SecretAccessKey?: string;
    readonly SessionToken?: string;
  };
}

export interface AwsMetricDataResponse {
  readonly MetricDataResults?: readonly {
    readonly Id?: string;
    readonly Timestamps?: readonly Date[];
    readonly Values?: readonly number[];
    readonly StatusCode?: string;
    readonly Messages?: readonly { readonly Code?: string; readonly Value?: string }[];
  }[];
  readonly NextToken?: string;
}

export interface AwsListMetricsResponse {
  readonly Metrics?: readonly {
    readonly Namespace?: string;
    readonly MetricName?: string;
    readonly Unit?: string;
    readonly Dimensions?: readonly { readonly Name?: string; readonly Value?: string }[];
  }[];
  readonly NextToken?: string;
}

export interface AwsGetObjectResponse { readonly Body?: unknown }

export interface AwsListObjectsResponse {
  readonly Contents?: readonly {
    readonly Key?: string;
    readonly Size?: number;
    readonly LastModified?: Date;
  }[];
  readonly IsTruncated?: boolean;
  readonly NextContinuationToken?: string;
}

export interface AwsDescribeInstancesResponse {
  readonly Reservations?: readonly { readonly Instances?: readonly AwsEc2Instance[] }[];
  readonly NextToken?: string;
}

export interface AwsDescribeRegionsResponse {
  readonly Regions?: readonly {
    readonly RegionName?: string;
    readonly OptInStatus?: string;
  }[];
}

export interface AwsDescribeVolumesResponse {
  readonly Volumes?: readonly AwsEbsVolume[];
  readonly NextToken?: string;
}

export interface AwsEbsVolume {
  readonly VolumeId?: string;
  readonly VolumeType?: string;
  readonly Size?: number;
  readonly State?: string;
  readonly Iops?: number;
  readonly Throughput?: number;
  readonly AvailabilityZone?: string;
  readonly Encrypted?: boolean;
  readonly Tags?: readonly { readonly Key?: string; readonly Value?: string }[];
  readonly Attachments?: readonly { readonly InstanceId?: string; readonly State?: string }[];
}

export interface AwsCallerIdentityResponse {
  readonly Account?: string;
  readonly Arn?: string;
}

export interface AwsCostExplorerResponse {
  readonly ResultsByTime?: readonly {
    readonly TimePeriod?: { readonly Start?: string; readonly End?: string };
    readonly Groups?: readonly {
      readonly Keys?: readonly string[];
      readonly Metrics?: Readonly<Record<string, { readonly Amount?: string; readonly Unit?: string }>>;
    }[];
  }[];
  readonly NextPageToken?: string;
}

export interface AwsEc2Instance {
  readonly InstanceId?: string;
  readonly InstanceType?: string;
  readonly State?: { readonly Name?: string };
  readonly Placement?: { readonly AvailabilityZone?: string };
  readonly Tags?: readonly { readonly Key?: string; readonly Value?: string }[];
}
