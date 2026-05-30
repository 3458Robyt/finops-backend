import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService } from '../../application/services/AuthService.js';
import { AuthenticationError, FinOpsBaseError } from '../../domain/errors/errors.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * Controlador de la capa de presentación para la autenticación (montado en
 * `/api/v1/auth`). Traduce las peticiones HTTP de login hacia el caso de uso de
 * autenticación y serializa el token y los datos de usuario en la respuesta.
 *
 * A diferencia de otros controladores, sus endpoints NO requieren autenticación
 * previa, ya que el login es el punto de entrada para obtener el token.
 *
 * Servicios que utiliza:
 * - {@link AuthService}: valida credenciales y emite el token de acceso.
 */
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Autentica a un usuario por email y contraseña y devuelve un token de acceso.
   *
   * Sirve: POST /api/v1/auth/login
   * Autenticación: no requerida (endpoint público de entrada).
   *
   * Cuerpo (`req.body`, validado con `loginSchema`):
   * - `email`: correo electrónico válido.
   * - `password`: contraseña (no vacía).
   *
   * Además registra el contexto de la petición para auditoría: `req.ip`
   * (dirección IP) y la cabecera `user-agent`, cuando están disponibles.
   *
   * Respuestas:
   * - 200: `{ success: true, accessToken, expiresAt, user }` con el token y su caducidad (ISO).
   * - 400 VALIDATION_ERROR: el cuerpo no cumple el esquema.
   * - 401: credenciales inválidas ({@link AuthenticationError}).
   * - 500: error de dominio no relacionado con credenciales o error inesperado.
   */
  public login = async (req: Request, res: Response): Promise<void> => {
    const parsed = loginSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid login payload',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    try {
      const userAgent = req.header('user-agent');
      const result = await this.authService.login({
        email: parsed.data.email,
        password: parsed.data.password,
        ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
        ...(userAgent !== undefined ? { userAgent } : {}),
      });

      res.status(200).json({
        success: true,
        accessToken: result.accessToken,
        expiresAt: result.expiresAt.toISOString(),
        user: result.user,
      });
    } catch (error: unknown) {
      if (error instanceof AuthenticationError) {
        res.status(401).json({
          success: false,
          error: error.message,
          code: error.code,
        });
        return;
      }

      if (error instanceof FinOpsBaseError) {
        res.status(500).json({
          success: false,
          error: error.message,
          code: error.code,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'An unexpected authentication error occurred',
      });
    }
  };
}
