import { describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig } from './runtimeConfigReader.js';

describe('loadRuntimeConfig', () => {
  it('projects process roles, HTTP settings and worker flags into typed config', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const config = loadRuntimeConfig({
      NODE_ENV: 'development',
      APP_PROCESS_ROLE: 'worker',
      PORT: '4100',
      CORS_ORIGIN: 'http://localhost:5173,http://localhost:4173',
      DB_RUNTIME_ENFORCE: 'true',
      DB_RUNTIME_ROLE: 'finops_runtime',
      INGESTION_WORKER_ENABLED: 'true',
      INGESTION_WORKER_ID: 'worker-test',
      INGESTION_WORKER_INTERVAL_MS: '1500',
      AI_MAX_RETRIES: '2',
      FINOPS_REQUIRED_TAG_KEYS: 'environment, owner',
    });

    expect(config.environment.processRole).toBe('worker');
    expect(config.http.port).toBe(4100);
    expect(config.http.corsOrigins).toEqual(['http://localhost:5173', 'http://localhost:4173']);
    expect(config.database.runtimeEnforce).toBe(true);
    expect(config.workers.ingestion).toMatchObject({
      enabled: true,
      id: 'worker-test',
      intervalMs: 1500,
      jobLeaseMs: 300000,
      jobHeartbeatMs: 60000,
    });
    expect(config.ai.maxRetries).toBe(2);
    expect(config.email.timeoutMs).toBe(15_000);
    expect(config.telegram.timeoutMs).toBe(15_000);
    expect(config.cloud.requiredTagKeys).toEqual(['environment', 'owner']);

    warning.mockRestore();
  });

  it('uses safe development defaults without returning undefined primitives', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = loadRuntimeConfig({ NODE_ENV: 'development' });

    expect(config.environment.processRole).toBe('all');
    expect(config.http.port).toBe(3000);
    expect(config.security.cookieSameSite).toBe('lax');
    expect(config.ai.model).toBe('gpt-5.4-mini');
    expect(config.email.timeoutMs).toBe(15_000);
    expect(config.telegram.timeoutMs).toBe(15_000);
    expect(config.schedulers.ingestion.enabled).toBe(false);

    warning.mockRestore();
  });
});
