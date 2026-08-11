import { describe, expect, it, vi } from 'vitest';
import { validateRuntimeConfig } from './runtimeConfig.js';

const productionEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
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
});
