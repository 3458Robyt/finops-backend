import type { IPasswordHasher } from '../../domain/interfaces/IPasswordHasher.js';
import type { ITokenService } from '../../domain/interfaces/ITokenService.js';
import type { IUserRepository } from '../../domain/interfaces/IUserRepository.js';
import type { UserRole } from '../../domain/models/AuthContext.js';
import { AuthenticationError } from '../../domain/errors/errors.js';

/**
 * Datos de entrada para el caso de uso de inicio de sesión.
 */
export interface LoginInput {
  /** Correo del usuario. Se normaliza (trim + minúsculas) antes de buscar. */
  readonly email: string;
  /** Contraseña en texto plano; se verifica contra el hash almacenado, nunca se persiste. */
  readonly password: string;
  /** Dirección IP del cliente, registrada en la sesión para auditoría (opcional). */
  readonly ipAddress?: string;
  /** User-Agent del cliente, registrado en la sesión para auditoría (opcional). */
  readonly userAgent?: string;
}

/**
 * Resultado de un inicio de sesión exitoso.
 */
export interface LoginResult {
  /** Token de acceso JWT firmado que el cliente debe enviar en peticiones posteriores. */
  readonly accessToken: string;
  /** Instante de expiración del token de acceso. */
  readonly expiresAt: Date;
  /** Proyección segura del usuario autenticado (sin hash de contraseña). */
  readonly user: {
    readonly id: string;
    readonly tenantId: string;
    readonly email: string;
    readonly name: string;
    readonly role: UserRole;
  };
}

/**
 * Servicio de aplicación de autenticación — Caso de uso de login.
 *
 * Responsabilidad: validar credenciales de usuario, emitir un token de
 * acceso y registrar la sesión resultante. No expone detalles que permitan
 * distinguir entre "usuario inexistente", "usuario inactivo" o "contraseña
 * incorrecta" para evitar enumeración de cuentas.
 *
 * Colaboradores inyectados (DIP):
 * - {@link IUserRepository}: lectura de usuarios y persistencia de sesiones.
 * - {@link IPasswordHasher}: verificación del hash de contraseña.
 * - {@link ITokenService}: emisión de tokens de acceso firmados.
 */
export class AuthService {
  /**
   * @param users          - Repositorio de usuarios y sesiones.
   * @param passwordHasher - Verificador de contraseñas (hash seguro).
   * @param tokenService   - Emisor de tokens de acceso.
   */
  constructor(
    private readonly users: IUserRepository,
    private readonly passwordHasher: IPasswordHasher,
    private readonly tokenService: ITokenService,
  ) {}

  /**
   * Autentica a un usuario por correo y contraseña.
   *
   * Flujo y efectos secundarios:
   * 1. Normaliza el correo y busca el usuario.
   * 2. Verifica que exista y esté ACTIVE, y que la contraseña coincida.
   * 3. Emite un token JWT y **persiste** una nueva sesión.
   * 4. **Actualiza** la marca de último inicio de sesión del usuario.
   *
   * @param input - Credenciales y metadatos opcionales del cliente.
   * @returns Token de acceso, su expiración y la proyección del usuario.
   *
   * @throws {AuthenticationError} Si el usuario no existe, no está activo
   *         o la contraseña es incorrecta. El error es deliberadamente
   *         indistinguible entre estos casos para no filtrar información.
   */
  public async login(input: LoginInput): Promise<LoginResult> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const user = await this.users.findByEmail(normalizedEmail);

    if (user === null || user.status !== 'ACTIVE') {
      throw new AuthenticationError();
    }

    const passwordMatches = await this.passwordHasher.verify(
      user.passwordHash,
      input.password,
    );

    if (!passwordMatches) {
      throw new AuthenticationError();
    }

    const token = this.tokenService.issueToken({
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role,
    });

    await this.users.createSession({
      userId: user.id,
      jwtId: token.jwtId,
      expiresAt: token.expiresAt,
      ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    });

    await this.users.updateLastLogin(user.id, new Date());

    return {
      accessToken: token.token,
      expiresAt: token.expiresAt,
      user: {
        id: user.id,
        tenantId: user.tenantId,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }
}
