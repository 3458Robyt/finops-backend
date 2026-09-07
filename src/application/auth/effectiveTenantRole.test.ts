import { describe, expect, test } from 'vitest';
import { normalizeLegacyIdentityRole, resolveEffectiveTenantRole } from '../../domain/security/effectiveTenantRole.js';
import type { AccessibleTenant, AuthUser } from '../../domain/interfaces/IUserRepository.js';

const user: AuthUser = {
  id: 'user-1',
  tenantId: 'home',
  email: 'technician@example.com',
  name: 'Technician',
  passwordHash: 'hash',
  role: 'FINOPS_TECHNICIAN',
  status: 'ACTIVE',
};

function tenant(accessRole: AccessibleTenant['accessRole']): AccessibleTenant {
  return { id: 'tenant-1', name: 'Tenant', slug: 'tenant', accessRole };
}

describe('effective tenant role', () => {
  test('uses the assignment role instead of the global identity role', () => {
    expect(resolveEffectiveTenantRole(user, tenant('LEAD_TECHNICIAN'))).toBe('LEAD_TECHNICIAN');
    expect(resolveEffectiveTenantRole(user, tenant('OPERATOR_ADMIN'))).toBe('OPERATOR_ADMIN');
    expect(resolveEffectiveTenantRole(user, tenant('TECHNICIAN'))).toBe('FINOPS_TECHNICIAN');
  });

  test('normalizes legacy home roles without changing the stored identity', () => {
    expect(normalizeLegacyIdentityRole('ADMIN')).toBe('OPERATOR_ADMIN');
    expect(normalizeLegacyIdentityRole('VIEWER')).toBe('CLIENT_VIEWER');
    expect(resolveEffectiveTenantRole({ ...user, role: 'ADMIN' }, tenant('HOME'))).toBe('OPERATOR_ADMIN');
  });

  test('keeps master access global', () => {
    expect(resolveEffectiveTenantRole({ ...user, role: 'MASTER_ADMIN' }, tenant('MASTER'))).toBe('MASTER_ADMIN');
  });
});
