import { describe, expect, it } from 'vitest';
import { parseBootstrapInput } from './bootstrap-beta-master-admin.js';

const env = {
  NODE_ENV: 'production',
  BETA_MASTER_ADMIN_BOOTSTRAP_ENABLED: 'true',
  MFA_REQUIRED_FOR_PRIVILEGED: 'true',
  BETA_BOOTSTRAP_EXPECTED_DATABASE: 'finops_beta',
  DATABASE_URL: 'postgresql://runtime@db:5432/finops_beta',
  BETA_BOOTSTRAP_DATABASE_URL: 'postgresql://owner@db:5432/finops_beta',
};

describe('beta master-admin bootstrap input', () => {
  it('accepts the target tenant and normalizes the administrator identity', () => {
    const parsed = parseBootstrapInput(JSON.stringify({
      tenantSlug: 'Tak-Colombia',
      email: 'Admin@Example.com',
      name: 'Beta Admin',
      temporaryPassword: 'a-long-random-temporary-secret-value',
    }), env);

    expect(parsed).toMatchObject({ tenantSlug: 'demo-org', email: 'admin@example.com' });
    expect(parsed.temporaryPassword).toBe('a-long-random-temporary-secret-value');
  });

  it('rejects production bootstrap unless explicitly enabled with MFA', () => {
    expect(() => parseBootstrapInput('{}', { ...env, BETA_MASTER_ADMIN_BOOTSTRAP_ENABLED: 'false' }))
      .toThrow('One-time bootstrap is not enabled.');
    expect(() => parseBootstrapInput('{}', { ...env, MFA_REQUIRED_FOR_PRIVILEGED: 'false' }))
      .toThrow('Privileged-user MFA must be required.');
  });

  it('rejects a privileged URL targeting another host or using the runtime login', () => {
    const payload = {
      tenantSlug: 'demo-org',
      email: 'admin@example.com',
      name: 'Beta Admin',
      temporaryPassword: 'a-long-random-temporary-secret-value',
    };
    expect(() => parseBootstrapInput(JSON.stringify(payload), {
      ...env,
      BETA_BOOTSTRAP_DATABASE_URL: 'postgresql://owner@other-db:5432/finops_beta',
    })).toThrow('Bootstrap database must be the configured beta database, using a separate privileged login.');
    expect(() => parseBootstrapInput(JSON.stringify(payload), {
      ...env,
      BETA_BOOTSTRAP_DATABASE_URL: 'postgresql://runtime@db:5432/finops_beta',
    })).toThrow('Bootstrap database must be the configured beta database, using a separate privileged login.');
  });

  it('never includes an invalid secret value in validation errors', () => {
    const secret = 'should-never-be-echoed';
    let message = '';
    try {
      parseBootstrapInput(JSON.stringify({
        tenantSlug: 'demo-org',
        email: 'invalid',
        name: 'Beta Admin',
        temporaryPassword: secret,
      }), env);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toBe('email is invalid.');
    expect(message).not.toContain(secret);
  });
});
