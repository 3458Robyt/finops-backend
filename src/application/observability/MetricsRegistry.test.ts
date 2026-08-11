import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from './MetricsRegistry.js';

describe('MetricsRegistry', () => {
  it('exports bounded counters and histograms in Prometheus format', () => {
    const registry = new MetricsRegistry();
    registry.increment('http_requests_total', { method: 'GET', status_class: '2xx' });
    registry.observe('http_request_duration_ms', 42, { method: 'GET', status_class: '2xx' }, [50, 100]);

    const output = registry.toPrometheus();

    expect(output).toContain('finops_http_requests_total{method="GET",status_class="2xx"} 1');
    expect(output).toContain('finops_http_request_duration_ms_bucket{method="GET",status_class="2xx",le="50"} 1');
    expect(output).toContain('finops_http_request_duration_ms_count{method="GET",status_class="2xx"} 1');
  });

  it('ignores non-finite observations and sanitizes labels', () => {
    const registry = new MetricsRegistry();
    registry.observe('bad metric', Number.NaN, { 'bad key': 'x', safe: 'line\nvalue' });
    registry.increment('counter', { safe: 'line\nvalue' });

    const output = registry.toPrometheus();

    expect(output).not.toContain('bad_metric');
    expect(output).toContain('finops_counter{safe="line\\nvalue"} 1');
  });
});
