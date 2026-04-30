import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService } from '../../application/services/AuthService.js';
import { AuthenticationError, FinOpsBaseError } from '../../domain/errors/errors.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
