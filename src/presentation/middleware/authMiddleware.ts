import type { NextFunction, Request, Response } from 'express';
import type { ITokenService } from '../../domain/interfaces/ITokenService.js';
import type { UserRole } from '../../domain/models/AuthContext.js';
import { AuthorizationError } from '../../domain/errors/errors.js';

export function createAuthMiddleware(tokenService: ITokenService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization');

    if (header === undefined || !header.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'Missing Bearer token',
        code: 'AUTHENTICATION_REQUIRED',
      });
      return;
    }

    try {
      req.auth = tokenService.verifyToken(header.slice('Bearer '.length).trim());
      next();
    } catch {
      res.status(401).json({
        success: false,
        error: 'Invalid or expired token',
        code: 'AUTHENTICATION_FAILED',
      });
    }
  };
}

export function requireRole(allowedRoles: readonly UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.auth === undefined) {
      res.status(401).json({
        success: false,
        error: 'Authentication is required',
        code: 'AUTHENTICATION_REQUIRED',
      });
      return;
    }

    if (!allowedRoles.includes(req.auth.role)) {
      const error = new AuthorizationError();
      res.status(403).json({
        success: false,
        error: error.message,
        code: error.code,
      });
      return;
    }

    next();
  };
}
