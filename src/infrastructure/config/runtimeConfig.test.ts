import { describe, expect, it, vi } from 'vitest';
import { validateRuntimeConfig } from './runtimeConfig.js';

const productionEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  APP_PROCESS_ROLE: 'api',
  DATABASE_URL: 'postgresql://localhost/finops',
  JWT_SECRET: 'a-secure-jwt-secret-with-more-than-32-characters',
  CREDENTIAL_ENCRYPTION_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
  CORS_ORIGIN: 'https://finops.example.com',
  DB_RUNTIME_ENFORCE: 'true',
  DB_RUNTIME_ROLE: 'finops_runtime',
  DB_EXPECTED_MIGRATION: '202608120005_runtime_process_heartbeats',
  AI_API_KEY: 'sk-fixture-key',
  AI_BASE_URL: 'https://ai.example.com/v1',
  AI_MODEL: 'gpt-5.4-mini',
  AI_AUDITOR_MODEL: 'gpt-5.4-mini',
  MFA_REQUIRED_FOR_PRIVILEGED: 'true',
  METRICS_TOKEN: 'metrics-fixture-token',
};

describe('validateRuntimeConfig', () => {
  it('accepts production only with runtime tenant enforcement enabled', () => {
    expect(() => validateRuntimeConfig(productionEnv)).not.toThrow();
  });

  it.each([
    ['DB_RUNTIME_ENFORCE', undefined],
    ['DB_RUNTIME_ENFORCE', 'false'],
    ['DB_RUNTIME_ROLE', undefined],
    ['DB_RUNTIME_ROLE', 'postgres'],
  ])('rejects production when %s is %s', (key, value) => {
    expect(() => validateRuntimeConfig({ ...productionEnv, [key]: value }))
      .toThrow(`Configuracion runtime invalida.`);
  });

  it('keeps runtime enforcement optional during development', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => validateRuntimeConfig({ NODE_ENV: 'development' })).not.toThrow();
    warning.mockRestore();
  });

  it('rejects an explicitly invalid process role during development', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => validateRuntimeConfig({ NODE_ENV: 'development', APP_PROCESS_ROLE: 'unexpected' }))
      .toThrow('APP_PROCESS_ROLE');
    warning.mockRestore();
  });

  it.each(['yes', '1', 'enabled', ''])('rejects an invalid boolean configuration value: %s', (value) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => validateRuntimeConfig({ NODE_ENV: 'development', EMAIL_ENABLED: value }))
      .toThrow('EMAIL_ENABLED');
    warning.mockRestore();
  });

  it('accepts case-insensitive boolean values consistently in production', () => {
    expect(() => validateRuntimeConfig({
      ...productionEnv,
      DB_RUNTIME_ENFORCE: ' TRUE ',
      MFA_REQUIRED_FOR_PRIVILEGED: 'TrUe',
    })).not.toThrow();
  });

  it.each([undefined, 'unknown'])('rejects production when APP_PROCESS_ROLE is %s', (role) => {
    expect(() => validateRuntimeConfig({ ...productionEnv, APP_PROCESS_ROLE: role }))
      .toThrow(`Configuracion runtime invalida.`);
  });

  it.each([
    'ingestion-worker',
    'learning-worker',
    'recommendation-analysis-worker',
    'savings-reconciliation-worker',
    'ingestion-scheduler',
    'recommendation-analysis-scheduler',
    'notification-scheduler',
    'auth-cleanup-scheduler',
    'budget-scheduler',
  ] as const)('accepts the granular production process role %s', (role) => {
    expect(() => validateRuntimeConfig({ ...productionEnv, APP_PROCESS_ROLE: role })).not.toThrow();
  });

  it.each(['*', ',', 'https://finops.example.com/app', 'https://user:password@finops.example.com'])('rejects an unsafe production CORS origin: %s', (origin) => {
    expect(() => validateRuntimeConfig({ ...productionEnv, CORS_ORIGIN: origin }))
      .toThrow(`Configuracion runtime invalida.`);
  });

  it('accepts multiple explicit HTTP(S) origins without paths', () => {
    expect(() => validateRuntimeConfig({
      ...productionEnv,
      CORS_ORIGIN: 'https://finops.example.com,https://admin.example.com',
    })).not.toThrow();
  });

  it('rejects an unbounded learning auditor timeout in production', () => {
    expect(() => validateRuntimeConfig({
      ...productionEnv,
      LEARNING_AUDIT_TIMEOUT_MS: '1000',
    })).toThrow(`Configuracion runtime invalida.`);
  });

  it('rejects an outbound provider timeout below the production bound', () => {
    expect(() => validateRuntimeConfig({
      ...productionEnv,
      OUTBOUND_PROVIDER_TIMEOUT_MS: '1000',
    })).toThrow(`Configuracion runtime invalida.`);
  });

  it.each(['0', '91'])('rejects a technical metric catchup window outside OCI retention: %s', (value) => {
    expect(() => validateRuntimeConfig({ ...productionEnv, INGESTION_SCHEDULER_METRIC_CATCHUP_DAYS: value }))
      .toThrow(`Configuracion runtime invalida.`);
  });

  it('rejects an auth cleanup batch outside the bounded production range', () => {
    expect(() => validateRuntimeConfig({ ...productionEnv, AUTH_CLEANUP_BATCH_SIZE: '5001' }))
      .toThrow(`Configuracion runtime invalida.`);
  });

  it.each(['1000', '86400001'])('rejects a process heartbeat interval outside the production range: %s', (value) => {
    expect(() => validateRuntimeConfig({ ...productionEnv, PROCESS_HEARTBEAT_INTERVAL_MS: value }))
      .toThrow(`Configuracion runtime invalida.`);
  });

  it('requires credentials for enabled outbound integrations and scheduler targets', () => {
    expect(() => validateRuntimeConfig({
      ...productionEnv,
      EMAIL_ENABLED: 'true',
    })).toThrow(`Configuracion runtime invalida.`);
    expect(() => validateRuntimeConfig({
      ...productionEnv,
      TELEGRAM_ENABLED: 'true',
    })).toThrow(`Configuracion runtime invalida.`);
    expect(() => validateRuntimeConfig({
      ...productionEnv,
      MESSAGE_SCHEDULER_ENABLED: 'true',
    })).toThrow(`Configuracion runtime invalida.`);
    expect(() => validateRuntimeConfig({
      ...productionEnv,
      BUDGET_SCHEDULER_ENABLED: 'true',
    })).toThrow(`Configuracion runtime invalida.`);
  });

  it('validates credentials when integration flags use mixed case or whitespace', () => {
    expect(() => validateRuntimeConfig({
      ...productionEnv,
      EMAIL_ENABLED: ' TRUE ',
    })).toThrow(`Configuracion runtime invalida.`);
    expect(() => validateRuntimeConfig({
      ...productionEnv,
      TELEGRAM_ENABLED: 'TrUe',
    })).toThrow(`Configuracion runtime invalida.`);
    expect(() => validateRuntimeConfig({
      ...productionEnv,
      MESSAGE_SCHEDULER_ENABLED: ' true ',
    })).toThrow(`Configuracion runtime invalida.`);
  });

  it('accepts explicitly configured outbound integrations', () => {
    expect(() => validateRuntimeConfig({
      ...productionEnv,
      EMAIL_ENABLED: 'true',
      SMTP_HOST: 'smtp.example.test',
      SMTP_USER: 'alerts@example.test',
      SMTP_PASSWORD: 'smtp-secret',
      PASSWORD_RESET_URL: 'https://finops.example.test/reset-password',
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'telegram-secret',
      TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
      MESSAGE_SCHEDULER_ENABLED: 'true',
      MESSAGE_SCHEDULER_TENANT_ID: 'tenant-1',
      MESSAGE_SCHEDULER_USER_ID: 'user-1',
      BUDGET_SCHEDULER_ENABLED: 'true',
      BUDGET_SCHEDULER_TENANT_ID: 'tenant-1',
      BUDGET_SCHEDULER_USER_ID: 'user-1',
    })).not.toThrow();
  });
});
