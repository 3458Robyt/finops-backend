import { AuthorizationError } from '../errors/errors.js';
import type { UserRole } from '../models/AuthContext.js';

export const userRoles: readonly UserRole[] = [
  'MASTER_ADMIN',
  'OPERATOR_ADMIN',
  'FINOPS_TECHNICIAN',
  'ADMIN',
  'CLIENT_APPROVER',
  'CLIENT_VIEWER',
  'VIEWER',
];

export type FinOpsPermission =
  | 'FINOPS_READ'
  | 'TENANT_MANAGE'
  | 'CLOUD_MANAGE'
  | 'INGESTION_MANAGE'
  | 'AGENT_OBSERVE'
  | 'AGENT_CONFIGURE'
  | 'RECOMMENDATION_GENERATE'
  | 'RECOMMENDATION_DECIDE'
  | 'RECOMMENDATION_EXECUTE'
  | 'SAVINGS_MEASURE'
  | 'SAVINGS_VERIFY'
  | 'BUDGET_MANAGE'
  | 'COST_ALLOCATION_MANAGE'
  | 'VALUE_RECONCILE'
  | 'OUTBOUND_MANAGE'
  | 'PRIVILEGED_ACCOUNT';

export const finOpsPermissions: readonly FinOpsPermission[] = [
  'FINOPS_READ',
  'TENANT_MANAGE',
  'CLOUD_MANAGE',
  'INGESTION_MANAGE',
  'AGENT_OBSERVE',
  'AGENT_CONFIGURE',
  'RECOMMENDATION_GENERATE',
  'RECOMMENDATION_DECIDE',
  'RECOMMENDATION_EXECUTE',
  'SAVINGS_MEASURE',
  'SAVINGS_VERIFY',
  'BUDGET_MANAGE',
  'COST_ALLOCATION_MANAGE',
  'VALUE_RECONCILE',
  'OUTBOUND_MANAGE',
  'PRIVILEGED_ACCOUNT',
];

const readOnly: readonly FinOpsPermission[] = ['FINOPS_READ'];
const clientApprover: readonly FinOpsPermission[] = [
  ...readOnly,
  'RECOMMENDATION_DECIDE',
  'SAVINGS_VERIFY',
];
const technician: readonly FinOpsPermission[] = [
  ...clientApprover,
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
];
const tenantAdministrator: readonly FinOpsPermission[] = [
  ...technician,
  'AGENT_CONFIGURE',
  'OUTBOUND_MANAGE',
];

export const permissionsByRole: Readonly<Record<UserRole, readonly FinOpsPermission[]>> = {
  MASTER_ADMIN: [...tenantAdministrator, 'TENANT_MANAGE'],
  OPERATOR_ADMIN: tenantAdministrator,
  FINOPS_TECHNICIAN: technician,
  ADMIN: tenantAdministrator,
  CLIENT_APPROVER: clientApprover,
  CLIENT_VIEWER: readOnly,
  VIEWER: readOnly,
};

export function hasPermission(role: UserRole, permission: FinOpsPermission): boolean {
  return permissionsByRole[role].includes(permission);
}

export function requirePermission(
  role: UserRole,
  permission: FinOpsPermission,
  message = 'No está autorizado para realizar esta operación.',
): void {
  if (!hasPermission(role, permission)) throw new AuthorizationError(message);
}

export function rolesForPermission(permission: FinOpsPermission): readonly UserRole[] {
  return userRoles.filter((role) => hasPermission(role, permission));
}

export function isPrivilegedRole(role: UserRole): boolean {
  return hasPermission(role, 'PRIVILEGED_ACCOUNT');
}
