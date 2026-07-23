import type { Request, Response } from 'express';
import { z } from 'zod';

import type { RecommendationAnalysisService } from '../../application/services/RecommendationAnalysisService.js';
import type { RecommendationAnalysisRun } from '../../domain/models/RecommendationAnalysisRun.js';
import { resolveFinOpsError } from '../http/finOpsErrorResponse.js';

const queueSchema = z.object({
  externalResourceId: z.string().trim().min(1).max(500).optional(),
});

export class RecommendationAnalysisController {
  public constructor(private readonly service: RecommendationAnalysisService) {}

  public queue = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.unauthorized(res);
    const parsed = queueSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: 'La solicitud de análisis no es válida.' });
      return;
    }

    try {
      const result = await this.service.queue(req.auth, {
        ...(parsed.data.externalResourceId !== undefined
          ? { externalResourceId: parsed.data.externalResourceId }
          : {}),
      });
      res.status(202).json({
        success: true,
        reused: result.reused,
        run: serializeRun(result.run, false),
      });
    } catch (error: unknown) {
      this.respondError(res, error);
    }
  };

  public preview = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.unauthorized(res);
    const parsed = queueSchema.safeParse({
      ...(typeof req.query['externalResourceId'] === 'string'
        ? { externalResourceId: req.query['externalResourceId'] }
        : {}),
    });
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        error: 'El alcance del análisis no es válido.',
      });
      return;
    }

    try {
      const preview = await this.service.preview(req.auth, {
        ...(parsed.data.externalResourceId !== undefined
          ? { externalResourceId: parsed.data.externalResourceId }
          : {}),
      });
      res.status(200).json({
        success: true,
        preview: {
          ...preview,
          periodStart: preview.periodStart.toISOString(),
          periodEnd: preview.periodEnd.toISOString(),
        },
      });
    } catch (error: unknown) {
      this.respondError(res, error);
    }
  };

  public list = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.unauthorized(res);
    const limit = parseLimit(req.query['limit']);
    try {
      const runs = await this.service.list(req.auth, limit);
      res.status(200).json({ success: true, runs: runs.map((run) => serializeRun(run, false)) });
    } catch (error: unknown) {
      this.respondError(res, error);
    }
  };

  public get = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.unauthorized(res);
    try {
      const run = await this.service.get(req.auth, readRouteId(req.params['id']));
      if (run === null) {
        res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'La corrida de análisis no existe.' });
        return;
      }
      res.status(200).json({ success: true, run: serializeRun(run, true) });
    } catch (error: unknown) {
      this.respondError(res, error);
    }
  };

  public cancel = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.unauthorized(res);
    try {
      const run = await this.service.cancel(req.auth, readRouteId(req.params['id']));
      res.status(200).json({ success: true, run: serializeRun(run, true) });
    } catch (error: unknown) {
      this.respondError(res, error);
    }
  };

  public retry = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.unauthorized(res);
    try {
      const run = await this.service.retry(req.auth, readRouteId(req.params['id']));
      res.status(202).json({ success: true, run: serializeRun(run, true) });
    } catch (error: unknown) {
      this.respondError(res, error);
    }
  };

  private unauthorized(res: Response): void {
    res.status(401).json({ success: false, code: 'AUTHENTICATION_REQUIRED', error: 'Se requiere autenticación.' });
  }

  private respondError(res: Response, error: unknown): void {
    const resolved = resolveFinOpsError(error, 'No fue posible completar la operación de análisis.');
    res.status(resolved.status).json({
      success: false,
      error: resolved.error,
      ...(resolved.code !== undefined ? { code: resolved.code } : {}),
    });
  }
}

function serializeRun(run: RecommendationAnalysisRun, detail: boolean): Record<string, unknown> {
  return {
    id: run.id,
    trigger: run.trigger,
    scope: run.scope,
    ...(run.externalResourceId !== undefined ? { externalResourceId: run.externalResourceId } : {}),
    status: run.status,
    stage: run.stage,
    ...(run.periodStart !== undefined ? { periodStart: run.periodStart.toISOString() } : {}),
    ...(run.periodEnd !== undefined ? { periodEnd: run.periodEnd.toISOString() } : {}),
    ...(run.evidenceHash !== undefined ? { evidenceHash: run.evidenceHash } : {}),
    attempts: run.attempts,
    maxAttempts: run.maxAttempts,
    resourcesEvaluated: run.resourcesEvaluated,
    candidatesFound: run.candidatesFound,
    candidatesSkipped: run.candidatesSkipped,
    recommendationsGenerated: run.recommendationsGenerated,
    recommendationsRejected: run.recommendationsRejected,
    recommendationsPersisted: run.recommendationsPersisted,
    ...(run.model !== undefined ? { model: run.model } : {}),
    ...(run.auditorModel !== undefined ? { auditorModel: run.auditorModel } : {}),
    promptTokenEstimate: run.promptTokenEstimate,
    responseTokenEstimate: run.responseTokenEstimate,
    ...(run.latencyMs !== undefined ? { latencyMs: run.latencyMs } : {}),
    ...(run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
    ...(run.errorMessage !== undefined ? { errorMessage: run.errorMessage } : {}),
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt.toISOString() } : {}),
    ...(run.completedAt !== undefined ? { completedAt: run.completedAt.toISOString() } : {}),
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    recommendations: run.recommendations,
    ...(detail && run.readinessReport !== undefined ? { readinessReport: run.readinessReport } : {}),
    ...(detail && run.candidateResults !== undefined ? { candidateResults: run.candidateResults } : {}),
  };
}

function parseLimit(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 100) : undefined;
}

function readRouteId(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}
