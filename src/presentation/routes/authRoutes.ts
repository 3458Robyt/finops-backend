import { Router } from 'express';
import { AuthController } from '../controllers/AuthController.js';

export function createAuthRoutes(authController: AuthController): Router {
  const router = Router();

  router.post('/login', authController.login);

  return router;
}
