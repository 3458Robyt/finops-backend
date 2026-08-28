export interface CloudMetricDefinitionSummary {
  readonly id: string;
  readonly compartmentId: string;
  readonly namespace: string;
  readonly metricName: string;
  readonly externalResourceId: string;
  readonly regionId?: string;
  readonly dimensions?: Readonly<Record<string, unknown>>;
  readonly metricUnit?: string;
  readonly statistics: unknown;
}
