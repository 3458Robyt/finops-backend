import express, { Express } from 'express';
import cors from 'cors';
import { DataIngestionService } from '../application/services/DataIngestionService.js';
import { CostController } from './controllers/CostController.js';
import { createCostRoutes } from './routes/costRoutes.js';

export function createExpressServer(dataIngestionService: DataIngestionService): Express {
  const app = express();

  // Middleware
  app.use(cors()); // Permite peticiones del frontend en React
  app.use(express.json());

  // Controllers
  const costController = new CostController(dataIngestionService);

  // Routes
  app.use('/api/v1/costs', createCostRoutes(costController));

  // Healthcheck
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return app;
}
