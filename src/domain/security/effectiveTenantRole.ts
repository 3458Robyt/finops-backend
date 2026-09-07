import type { AccessibleTenant, AuthUser, EffectiveTenantRole } from '../interfaces/IUserRepository.js';

/** Resuelve el rol efectivo que gobierna una sesión dentro del tenant activo. */
export function resolveEffectiveTenantRole(user: AuthUser, tenant: AccessibleTenant): EffectiveTenantRole {
  if (user.role === 'MASTER_ADMIN' || tenant.accessRole === 'MASTER') return 'MASTER_ADMIN';
  return tenant.effectiveRole ?? resolveEffectiveRoleForAccess(tenant.accessRole, user.role);
}

/** Convierte un alcance HOME o una asignación operativa en un rol de sesión. */
export function resolveEffectiveRoleForAccess(
  accessRole: AccessibleTenant['accessRole'],
  identityRole: AuthUser['role'],
): EffectiveTenantRole {
  switch (accessRole) {
    case 'MASTER':
      return 'MASTER_ADMIN';
    case 'OPERATOR_ADMIN':
      return 'OPERATOR_ADMIN';
    case 'LEAD_TECHNICIAN':
      return 'LEAD_TECHNICIAN';
    case 'TECHNICIAN':
      return 'FINOPS_TECHNICIAN';
    case 'HOME':
      return normalizeLegacyIdentityRole(identityRole);
  }
}

export function normalizeLegacyIdentityRole(role: AuthUser['role']): EffectiveTenantRole {
  switch (role) {
    case 'ADMIN': return 'OPERATOR_ADMIN';
    case 'VIEWER': return 'CLIENT_VIEWER';
    case 'MASTER_ADMIN': return 'MASTER_ADMIN';
    case 'OPERATOR_ADMIN': return 'OPERATOR_ADMIN';
    case 'LEAD_TECHNICIAN': return 'LEAD_TECHNICIAN';
    case 'FINOPS_TECHNICIAN': return 'FINOPS_TECHNICIAN';
    case 'CLIENT_APPROVER': return 'CLIENT_APPROVER';
    case 'CLIENT_VIEWER': return 'CLIENT_VIEWER';
  }
}
