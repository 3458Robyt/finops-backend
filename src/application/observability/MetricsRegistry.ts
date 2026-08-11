type Labels = Readonly<Record<string, string>>;

interface Counter {
  readonly name: string;
  readonly labels: Labels;
  value: number;
}

interface Histogram {
  readonly name: string;
  readonly labels: Labels;
  readonly buckets: readonly number[];
  readonly counts: number[];
  count: number;
  sum: number;
}

const DEFAULT_BUCKETS = [5, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/** Small bounded in-process registry for health and Prometheus scraping. */
export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();

  public increment(name: string, labels: Labels = {}, value = 1): void {
    const key = metricKey(name, labels);
    const current = this.counters.get(key);
    if (current === undefined) {
      this.counters.set(key, { name, labels: normalizedLabels(labels), value });
      return;
    }
    current.value += value;
  }

  public observe(name: string, value: number, labels: Labels = {}, buckets = DEFAULT_BUCKETS): void {
    if (!Number.isFinite(value)) return;
    const normalizedBuckets = [...buckets].filter(Number.isFinite).sort((a, b) => a - b);
    const key = metricKey(name, labels);
    let histogram = this.histograms.get(key);
    if (histogram === undefined) {
      histogram = {
        name,
        labels: normalizedLabels(labels),
        buckets: normalizedBuckets,
        counts: normalizedBuckets.map(() => 0),
        count: 0,
        sum: 0,
      };
      this.histograms.set(key, histogram);
    }
    histogram.count += 1;
    histogram.sum += value;
    histogram.buckets.forEach((bucket, index) => {
      if (value <= bucket) histogram!.counts[index] = (histogram!.counts[index] ?? 0) + 1;
    });
  }

  public toPrometheus(): string {
    const lines: string[] = [
      '# HELP finops_process_metrics_info FinOps process metrics registry.',
      '# TYPE finops_process_metrics_info gauge',
      'finops_process_metrics_info 1',
    ];

    for (const counter of this.counters.values()) {
      lines.push(`${metricName(counter.name)}${formatLabels(counter.labels)} ${counter.value}`);
    }

    for (const histogram of this.histograms.values()) {
      const name = metricName(histogram.name);
      const baseLabels = formatLabels(histogram.labels);
      for (let index = 0; index < histogram.buckets.length; index += 1) {
        const labels = { ...histogram.labels, le: String(histogram.buckets[index]) };
        lines.push(`${name}_bucket${formatLabels(labels)} ${histogram.counts[index]}`);
      }
      lines.push(`${name}_bucket${formatLabels({ ...histogram.labels, le: '+Inf' })} ${histogram.count}`);
      lines.push(`${name}_sum${baseLabels} ${histogram.sum}`);
      lines.push(`${name}_count${baseLabels} ${histogram.count}`);
    }

    return `${lines.join('\n')}\n`;
  }
}

function metricKey(name: string, labels: Labels): string {
  return `${name}|${JSON.stringify(normalizedLabels(labels))}`;
}

function normalizedLabels(labels: Labels): Labels {
  return Object.fromEntries(
    Object.entries(labels)
      .filter(([key, value]) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && value.trim() !== '')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value.slice(0, 80)]),
  );
}

function metricName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_]/g, '_');
  return normalized.startsWith('finops_') ? normalized : `finops_${normalized}`;
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}
