/**
 * Roles de usuario del sistema, que determinan los permisos disponibles.
 *
 * - `ADMIN`: Administrador con acceso completo a la plataforma.
 * - `VIEWER`: Usuario con acceso de solo lectura.
 * - `OPERATOR_ADMIN`: Administrador del operador (proveedor del servicio FinOps).
 * - `FINOPS_TECHNICIAN`: Técnico FinOps con permisos operativos.
 * - `CLIENT_APPROVER`: Usuario del cliente con permiso para aprobar recomendaciones.
 * - `CLIENT_VIEWER`: Usuario del cliente con acceso de solo lectura.
 */
export type UserRole =
  | 'ADMIN'
  | 'VIEWER'
  | 'OPERATOR_ADMIN'
  | 'FINOPS_TECHNICIAN'
  | 'CLIENT_APPROVER'
  | 'CLIENT_VIEWER';

/**
 * Contexto de autenticación del usuario asociado a una petición. Se deriva del
 * JWT validado y se propaga por la capa de aplicación para autorización y
 * aislamiento multi-tenant.
 */
export interface AuthContext {
  /** Identificador único del usuario autenticado. */
  readonly userId: string;
  /** Tenant (cliente) al que pertenece el usuario; clave del aislamiento multi-tenant. */
  readonly tenantId: string;
  /** Correo electrónico del usuario. */
  readonly email: string;
  /** Rol del usuario, que determina sus permisos. */
  readonly role: UserRole;
  /** Identificador del JWT (claim `jti`) usado para trazabilidad y revocación. */
  readonly jwtId: string;
}
