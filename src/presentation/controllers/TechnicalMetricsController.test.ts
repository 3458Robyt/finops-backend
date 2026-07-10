import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { TechnicalMetricsService } from '../../application/services/TechnicalMetricsService.js';
import { TechnicalMetricsController } from './TechnicalMetricsController.js';

describe('TechnicalMetricsController', () => {
  it('rejects incomplete series ranges before invoking the service', async () => {
    const service = {
      getSeries: vi.fn(),
    } as unknown as TechnicalMetricsService;
    const controller = new TechnicalMetricsController(service);
    const response = createResponse();

    await controller.getSeries(createRequest({
      metricNames: 'CpuUtilization',
      bucket: 'raw',
    }), response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      code: 'VALIDATION_ERROR',
    });
    expect(service.getSeries).not.toHaveBeenCalled();
  });

  it('rejects an invalid bucket instead of falling back silently', async () => {
    const service = {
      getSeries: vi.fn(),
    } as unknown as TechnicalMetricsService;
    const controller = new TechnicalMetricsController(service);
    const response = createResponse();

    await controller.getSeries(createRequest({
      startDate: '2026-06-01T00:00:00.000Z',
      endDate: '2026-06-02T00:00:00.000Z',
      metricNames: 'CpuUtilization',
      bucket: 'week',
    }), response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      code: 'VALIDATION_ERROR',
    });
    expect(service.getSeries).not.toHaveBeenCalled();
  });
});

function createRequest(query: Record<string, string>): Request {
  return {
    query,
    auth: { tenantId: 'tenant-1' },
  } as unknown as Request;
}

function createResponse(): Response & { statusCode: number; body: unknown } {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(statusCode: number) {
      response.statusCode = statusCode;
      return response;
    },
    json(body: unknown) {
      response.body = body;
      return response;
    },
  };

  return response as unknown as Response & { statusCode: number; body: unknown };
}
