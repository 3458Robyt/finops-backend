import { describe, expect, test } from 'vitest';
import {
  finOpsPermissions,
  hasPermission,
  isPrivilegedRole,
  permissionsByRole,
  requirePermission,
  rolesForPermission,
  userRoles,
} from './AuthorizationPolicy.js';

describe('FinOps authorization policy', () => {
  test('matches the complete reviewed role-permission matrix', () => {
    const technicianPermissions = [
      'FINOPS_READ',
      'RECOMMENDATION_DECIDE',
      'SAVINGS_VERIFY',
      'CLOUD_MANAGE',
      'INGESTION_MANAGE',
      'AGENT_OBSERVE',
      'RECOMMENDATION_GENERATE',
      'RECOMMENDATION_EXECUTE',
      'SAVINGS_MEASURE',
      'BUDGET_MANAGE',
      'COST_ALLOCATION_MANAGE',
      'VALUE_RECONCILE',
      'PRIVILEGED_ACCOUNT',
    ] as const;
    const tenantAdminPermissions = [...technicianPermissions, 'AGENT_CONFIGURE', 'OUTBOUND_MANAGE'] as const;

    expect(permissionsByRole).toEqual({
      MASTER_ADMIN: [...tenantAdminPermissions, 'TENANT_MANAGE'],
      OPERATOR_ADMIN: tenantAdminPermissions,
      FINOPS_TECHNICIAN: technicianPermissions,
      ADMIN: tenantAdminPermissions,
      CLIENT_APPROVER: ['FINOPS_READ', 'RECOMMENDATION_DECIDE', 'SAVINGS_VERIFY'],
      CLIENT_VIEWER: ['FINOPS_READ'],
      VIEWER: ['FINOPS_READ'],
    });
  });

  test('defines an explicit permission set for every role', () => {
    expect(Object.keys(permissionsByRole).sort()).toEqual([...userRoles].sort());
    expect(userRoles.every((role) => permissionsByRole[role].includes('FINOPS_READ'))).toBe(true);
    expect(finOpsPermissions.every((permission) => rolesForPermission(permission).length > 0)).toBe(true);
    expect(userRoles.every((role) => new Set(permissionsByRole[role]).size === permissionsByRole[role].length)).toBe(true);
  });

  test('keeps privileged operational capabilities away from viewers', () => {
    for (const role of ['VIEWER', 'CLIENT_VIEWER'] as const) {
      expect(hasPermission(role, 'CLOUD_MANAGE')).toBe(false);
      expect(hasPermission(role, 'RECOMMENDATION_DECIDE')).toBe(false);
      expect(hasPermission(role, 'OUTBOUND_MANAGE')).toBe(false);
    }
    expect(hasPermission('CLIENT_APPROVER', 'RECOMMENDATION_DECIDE')).toBe(true);
    expect(hasPermission('CLIENT_APPROVER', 'RECOMMENDATION_EXECUTE')).toBe(false);
    expect(hasPermission('CLIENT_APPROVER', 'SAVINGS_VERIFY')).toBe(true);
    expect(hasPermission('CLIENT_APPROVER', 'SAVINGS_MEASURE')).toBe(false);
  });

  test('matches the established operational and agent administration boundaries', () => {
    expect(rolesForPermission('CLOUD_MANAGE')).toEqual([
      'MASTER_ADMIN', 'OPERATOR_ADMIN', 'FINOPS_TECHNICIAN', 'ADMIN',
    ]);
    expect(rolesForPermission('AGENT_CONFIGURE')).toEqual([
      'MASTER_ADMIN', 'OPERATOR_ADMIN', 'ADMIN',
    ]);
    expect(rolesForPermission('AGENT_OBSERVE')).toEqual([
      'MASTER_ADMIN', 'OPERATOR_ADMIN', 'FINOPS_TECHNICIAN', 'ADMIN',
    ]);
    expect(rolesForPermission('TENANT_MANAGE')).toEqual(['MASTER_ADMIN']);
    expect(isPrivilegedRole('FINOPS_TECHNICIAN')).toBe(true);
    expect(isPrivilegedRole('CLIENT_APPROVER')).toBe(false);
  });

  test('fails closed for missing permissions', () => {
    expect(() => requirePermission('VIEWER', 'BUDGET_MANAGE')).toThrow(/autorizado/i);
    expect(() => requirePermission('ADMIN', 'BUDGET_MANAGE')).not.toThrow();
  });
});
