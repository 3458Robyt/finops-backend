import { describe, expect, test, vi } from 'vitest';
import type { Request, Response } from 'express';
import { KpiController } from './KpiController.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';

describe('KpiController adoption filters', () => {
  test('rejects repeated query parameters instead of choosing an arbitrary value', async () => {
    const getAdoptionKpis = vi.fn();
    const controller = new KpiController({ getAdoptionKpis } as unknown as IRecommendationRepository);
    const response = createResponse();

    await controller.getAdoption(
      createRequest({ from: ['2026-01-01', '2026-02-01'] }),
      response as unknown as Response,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    expect(getAdoptionKpis).not.toHaveBeenCalled();
  });

  test('passes a single valid period and granularity to the repository', async () => {
    const getAdoptionKpis = vi.fn().mockResolvedValue({ activeUsers: 0 });
    const controller = new KpiController({ getAdoptionKpis } as unknown as IRecommendationRepository);
    const response = createResponse();

    await controller.getAdoption(
      createRequest({ from: '2026-01-01', to: '2026-02-01', granularity: 'week' }),
      response as unknown as Response,
    );

    expect(response.statusCode).toBe(200);
    expect(getAdoptionKpis).toHaveBeenCalledWith('tenant-1', {
      from: new Date('2026-01-01'),
      to: new Date('2026-02-01'),
      granularity: 'week',
    });
  });
});

function createRequest(query: Record<string, unknown>): Request {
  return {
    auth: {
      userId: 'user-1',
      tenantId: 'tenant-1',
      email: 'test-user-0002@example.test',
      role: 'ADMIN',
      jwtId: 'jwt-1',
    },
    query,
  } as unknown as Request;
}

function createResponse(): {
  statusCode: number;
  body: unknown;
  status: (statusCode: number) => { json: (body: unknown) => void };
  json: (body: unknown) => void;
} {
  return {
    statusCode: 200,
    body: undefined,
    status(statusCode: number) {
      this.statusCode = statusCode;
      return this;
    },
    json(body: unknown) {
      this.body = body;
    },
  };
}
