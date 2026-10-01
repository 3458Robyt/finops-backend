import { describe, expect, test, vi } from 'vitest';
import { FinOpsBaseError } from '../../../domain/errors/errors.js';
import { respondWithRecommendationError } from './recommendationErrorResponse.js';

describe('respondWithRecommendationError', () => {
  test('exposes provider timeout as a gateway timeout', () => {
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as never;

    respondWithRecommendationError(
      response,
      new FinOpsBaseError('El proveedor excedió el tiempo máximo', 'PROVIDER_TIMEOUT'),
      'fallback',
    );

    expect(response.status).toHaveBeenCalledWith(504);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      code: 'PROVIDER_TIMEOUT',
    }));
  });

  test('exposes invalid provider output as a bad gateway', () => {
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as never;

    respondWithRecommendationError(
      response,
      new FinOpsBaseError('Respuesta inválida del proveedor', 'AI_RESPONSE_ERROR'),
      'fallback',
    );

    expect(response.status).toHaveBeenCalledWith(502);
  });

  test('exposes transient provider availability as service unavailable', () => {
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as never;

    respondWithRecommendationError(
      response,
      new FinOpsBaseError('El proveedor no está disponible temporalmente', 'PROVIDER_UNAVAILABLE'),
      'fallback',
    );

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      code: 'PROVIDER_UNAVAILABLE',
    }));
  });
});
