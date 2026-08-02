import { describe, expect, test, vi } from 'vitest';
import type { Request, Response } from 'express';

import type { RecommendationAnalysisService } from '../../application/services/RecommendationAnalysisService.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import type { RecommendationAnalysisRun } from '../../domain/models/RecommendationAnalysisRun.js';
import { RecommendationAnalysisController } from './RecommendationAnalysisController.js';

const auth: AuthContext = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  email: 'admin@example.com',
  role: 'ADMIN',
  jwtId: 'jwt-1',
};

describe('RecommendationAnalysisController', () => {
  test('responde 202 sin esperar el procesamiento de IA', async () => {
    const service = {
      queue: vi.fn(async () => ({ run: buildRun(), reused: false })),
    } as unknown as RecommendationAnalysisService;
    const controller = new RecommendationAnalysisController(service);
    const response = createResponse();

    await controller.queue({ auth, body: {} } as Request, response.value);

    expect(response.status).toHaveBeenCalledWith(202);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      reused: false,
      run: expect.objectContaining({ status: 'PENDING', stage: 'QUEUED' }),
    }));
  });

  test('expone readiness determinístico sin snapshot crudo', async () => {
    const service = {
      preview: vi.fn(async () => ({
        scope: 'TENANT',
        periodStart: new Date('2026-06-01T00:00:00.000Z'),
        periodEnd: new Date('2026-07-01T00:00:00.000Z'),
        evidenceHash: 'hash-1',
        resourcesEvaluated: 2,
        candidatesFound: 1,
        candidatesSkipped: 1,
        readinessReport: { candidates: [], blocked: [], deferred: [], summary: 'fixture' },
      })),
    } as unknown as RecommendationAnalysisService;
    const controller = new RecommendationAnalysisController(service);
    const response = createResponse();

    await controller.preview({ auth, query: {} } as Request, response.value);

    expect(response.status).toHaveBeenCalledWith(200);
    const payload = response.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('snapshot');
    expect(payload).toEqual(expect.objectContaining({
      success: true,
      preview: expect.objectContaining({ candidatesFound: 1 }),
    }));
  });
});

function createResponse() {
  const status = vi.fn();
  const json = vi.fn();
  const value = { status: status.mockReturnThis(), json } as unknown as Response;
  return { value, status, json };
}

function buildRun(): RecommendationAnalysisRun {
  const now = new Date('2026-07-23T00:00:00.000Z');
  return {
    id: 'run-1',
    tenantId: 'tenant-1',
    requestedByUserId: 'user-1',
    trigger: 'MANUAL',
    scope: 'TENANT',
    scopeKey: '__tenant__',
    status: 'PENDING',
    stage: 'QUEUED',
    attempts: 0,
    maxAttempts: 2,
    resourcesEvaluated: 0,
    candidatesFound: 0,
    candidatesSkipped: 0,
    recommendationsGenerated: 0,
    recommendationsRejected: 0,
    recommendationsPersisted: 0,
    promptTokenEstimate: 0,
    responseTokenEstimate: 0,
    createdAt: now,
    updatedAt: now,
    recommendations: [],
  };
}
