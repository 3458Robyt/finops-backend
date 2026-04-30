import express, { type Express } from 'express';
import cors from 'cors';
import type { AuthService } from '../application/services/AuthService.js';
import type { ICostRepository } from '../domain/interfaces/ICostRepository.js';
import type { IRecommendationRepository } from '../domain/interfaces/IRecommendationRepository.js';
import type { ITokenService } from '../domain/interfaces/ITokenService.js';
import { AuthController } from './controllers/AuthController.js';
import { CostController } from './controllers/CostController.js';
import { RecommendationController } from './controllers/RecommendationController.js';
import { createAuthMiddleware } from './middleware/authMiddleware.js';
import { createAuthRoutes } from './routes/authRoutes.js';
import { createCostRoutes } from './routes/costRoutes.js';
import { createRecommendationRoutes } from './routes/recommendationRoutes.js';

interface ServerDependencies {
  readonly authService: AuthService;
  readonly costRepository: ICostRepository;
  readonly recommendationRepository: IRecommendationRepository;
  readonly tokenService: ITokenService;
}

export function createExpressServer(dependencies: ServerDependencies): Express {
  const app = express();

  app.use(cors({
    origin: process.env['CORS_ORIGIN'] ?? 'http://localhost:5173',
    credentials: true,
  }));
  app.use(express.json());

  const authController = new AuthController(dependencies.authService);
  const costController = new CostController(dependencies.costRepository);
  const recommendationController = new RecommendationController(dependencies.recommendationRepository);
  const requireAuth = createAuthMiddleware(dependencies.tokenService);

  app.use('/api/v1/auth', createAuthRoutes(authController));
  app.use('/api/v1/costs', createCostRoutes(costController, requireAuth));
  app.use('/api/v1/recommendations', createRecommendationRoutes(recommendationController, requireAuth));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return app;
}
