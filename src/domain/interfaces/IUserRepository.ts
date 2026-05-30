import type { UserRole } from '../models/AuthContext.js';

/**
 * Proyección de un usuario empleada durante el proceso de autenticación.
 *
 * Contiene únicamente los campos necesarios para validar credenciales y
 * construir el contexto de sesión; no representa el agregado completo de usuario.
 */
export interface AuthUser {
  readonly id: string;
  /** Tenant (organización) al que pertenece el usuario; clave del aislamiento multi-tenant. */
  readonly tenantId: string;
  readonly email: string;
  readonly name: string;
  /** Hash de la contraseña almacenado; nunca la contraseña en texto plano. */
  readonly passwordHash: string;
  /** Rol que determina los permisos del usuario dentro del tenant. */
  readonly role: UserRole;
  /** Estado de la cuenta: `ACTIVE` permite iniciar sesión; `DISABLED` la bloquea. */
  readonly status: 'ACTIVE' | 'DISABLED';
}

/**
 * Datos necesarios para registrar una nueva sesión de usuario tras el login.
 */
export interface CreateSessionInput {
  readonly userId: string;
  /** Identificador del token (claim `jti`) que vincula la sesión con el JWT emitido. */
  readonly jwtId: string;
  /** Instante de expiración de la sesión, alineado con la vigencia del token. */
  readonly expiresAt: Date;
  /** Dirección IP de origen de la sesión; opcional, usado para auditoría. */
  readonly ipAddress?: string;
  /** Agente de usuario (navegador/cliente) de origen; opcional, usado para auditoría. */
  readonly userAgent?: string;
}

/**
 * Contrato de repositorio de usuarios para el flujo de autenticación.
 *
 * Puerto de dominio (DIP) cuya implementación concreta reside en la capa de
 * infraestructura (acceso a base de datos). Expone solo las operaciones
 * requeridas por el inicio de sesión y la gestión de sesiones.
 */
export interface IUserRepository {
  /**
   * Busca un usuario por su correo electrónico.
   *
   * @param email - Correo electrónico del usuario a localizar.
   * @returns El usuario de autenticación si existe; `null` si no hay coincidencia.
   */
  findByEmail(email: string): Promise<AuthUser | null>;

  /**
   * Actualiza la marca temporal del último inicio de sesión del usuario.
   *
   * @param userId     - Identificador del usuario.
   * @param loggedInAt - Instante del inicio de sesión a registrar.
   */
  updateLastLogin(userId: string, loggedInAt: Date): Promise<void>;

  /**
   * Persiste una nueva sesión asociada a un token emitido.
   *
   * @param input - Datos de la sesión a crear (usuario, identificador de token, expiración y metadatos opcionales).
   */
  createSession(input: CreateSessionInput): Promise<void>;
}
