import { describe, expect, test, vi } from 'vitest';
import { AiAuditRejectedError, FinOpsBaseError } from '../../domain/errors/errors.js';
import { respondWithFinOpsError, resolveFinOpsError } from './finOpsErrorResponse.js';

describe('finOpsErrorResponse', () => {
  test('maps known domain errors consistently', () => {
    expect(resolveFinOpsError(new FinOpsBaseError('not found', 'NOT_FOUND'), 'fallback')).toEqual({
      status: 404,
      error: 'not found',
      code: 'NOT_FOUND',
    });
    expect(resolveFinOpsError(new FinOpsBaseError('conflict', 'CONFLICT'), 'fallback').status).toBe(409);
    expect(resolveFinOpsError(new FinOpsBaseError('provider unavailable', 'AI_RESPONSE_ERROR'), 'fallback').status).toBe(502);
  });

  test('preserves the audit payload and diagnostic id for rejected AI artifacts', () => {
    const error = new AiAuditRejectedError('artifact rejected', {
      diagnosticId: 'trace-1',
      audit: { verdict: 'REJECTED' },
    });

    expect(resolveFinOpsError(error, 'fallback')).toEqual({
      status: 422,
      error: 'artifact rejected',
      code: 'AI_AUDIT_REJECTED',
      diagnosticId: 'trace-1',
      audit: { verdict: 'REJECTED' },
    });

    const response = {
      locals: { requestId: 'request-1' },
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as never;
    respondWithFinOpsError(response, error, 'fallback', 'ai_event');
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ diagnosticId: 'trace-1' }));
  });

  test('adds diagnostic id and sanitizes unexpected errors', () => {
    const response = {
      locals: { requestId: 'request-1' },
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as never;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    respondWithFinOpsError(response, new Error('password=super-secret'), 'fallback', 'test_event', '/test');

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: 'fallback',
      diagnosticId: 'request-1',
    }));
    expect(log).toHaveBeenCalledWith(expect.not.stringContaining('super-secret'));
    log.mockRestore();
  });

  test('supports lightweight response doubles without locals', () => {
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as never;

    respondWithFinOpsError(
      response,
      new FinOpsBaseError('invalid request', 'VALIDATION_ERROR'),
      'fallback',
      'test_event',
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: 'invalid request',
      code: 'VALIDATION_ERROR',
    });
  });
});
