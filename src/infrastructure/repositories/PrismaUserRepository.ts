import type {
  AuthUser,
  CreateSessionInput,
  IUserRepository,
} from '../../domain/interfaces/IUserRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Adaptador de infraestructura (Clean Architecture) que implementa el puerto de
 * dominio {@link IUserRepository} sobre Prisma/PostgreSQL.
 *
 * Responsabilidad: persistencia y consulta de identidades de usuario y sesiones
 * de autenticación. Encapsula el acceso a las tablas `users` y `auth_sessions`,
 * exponiendo únicamente los datos necesarios para el flujo de autenticación
 * (login, registro de sesión JWT y actualización de último acceso).
 */
export class PrismaUserRepository implements IUserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Busca un usuario por su correo electrónico (clave única global).
   *
   * Selecciona explícitamente solo los campos requeridos para autenticar,
   * incluyendo el `passwordHash`, por lo que el resultado no debe exponerse
   * directamente hacia capas externas sin filtrar credenciales.
   *
   * @param email Correo electrónico exacto a buscar.
   * @returns El usuario en formato de dominio {@link AuthUser}, o `null` si no
   *   existe ningún usuario con ese correo.
   */
  public async findByEmail(email: string): Promise<AuthUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        tenantId: true,
        email: true,
        name: true,
        passwordHash: true,
        role: true,
        status: true,
      },
    });

    if (user === null) {
      return null;
    }

    return {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      name: user.name,
      passwordHash: user.passwordHash,
      role: user.role,
      status: user.status,
    };
  }

  /**
   * Registra la marca temporal del último inicio de sesión exitoso del usuario.
   *
   * @param userId Identificador del usuario a actualizar.
   * @param loggedInAt Fecha/hora del acceso a persistir en `lastLoginAt`.
   * @returns Promesa que se resuelve cuando la actualización finaliza.
   */
  public async updateLastLogin(userId: string, loggedInAt: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastLoginAt: loggedInAt },
    });
  }

  /**
   * Crea una sesión de autenticación (registro del token JWT emitido).
   *
   * Persiste el identificador del JWT (`jwtId`) junto con su expiración para
   * permitir revocación/validación posterior. Los campos `ipAddress` y
   * `userAgent` son opcionales y solo se incluyen cuando se proporcionan.
   *
   * @param input Datos de la sesión a crear (usuario, jwtId, expiración y
   *   metadatos opcionales de origen).
   * @returns Promesa que se resuelve cuando la sesión queda persistida.
   */
  public async createSession(input: CreateSessionInput): Promise<void> {
    await this.prisma.authSession.create({
      data: {
        userId: input.userId,
        jwtId: input.jwtId,
        expiresAt: input.expiresAt,
        ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
        ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
      },
    });
  }
}
