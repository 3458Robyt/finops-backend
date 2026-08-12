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

  it.each([undefined, 'unknown'])('rejects production when APP_PROCESS_ROLE is %s', (role) => {
    expect(() => validateRuntimeConfig({ ...productionEnv, APP_PROCESS_ROLE: role }))
      .toThrow(`Configuracion runtime invalida.`);
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
    })).not.toThrow();
  });
});
