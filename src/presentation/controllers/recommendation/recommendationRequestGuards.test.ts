import type { Response } from 'express';
import { describe, expect, test, vi } from 'vitest';
import type { AuthContext } from '../../../domain/models/AuthContext.js';
import {
  hasPermission,
  userRoles,
  type FinOpsPermission,
} from '../../../domain/security/AuthorizationPolicy.js';
import {
  requireRecommendationDecisionRole,
  requireRecommendationExecutionRole,
  requireSavingsMeasurementRole,
  requireSavingsVerificationRole,
} from './recommendationRequestGuards.js';

const guards = [
  ['RECOMMENDATION_DECIDE', requireRecommendationDecisionRole],
  ['RECOMMENDATION_EXECUTE', requireRecommendationExecutionRole],
  ['SAVINGS_MEASURE', requireSavingsMeasurementRole],
  ['SAVINGS_VERIFY', requireSavingsVerificationRole],
] as const satisfies readonly [FinOpsPermission, (response: Response, auth: AuthContext) => boolean][];

describe('recommendation authorization guards', () => {
  test.each(guards)('%s follows the central authorization policy for every role', (permission, guard) => {
    for (const role of userRoles) {
      const { response, status, json } = createResponse();
      const allowed = guard(response, buildAuth(role));

      expect(allowed).toBe(hasPermission(role, permission));
      if (allowed) {
        expect(status).not.toHaveBeenCalled();
      } else {
        expect(status).toHaveBeenCalledWith(403);
        expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTHORIZATION_FAILED' }));
      }
    }
  });
});

function buildAuth(role: AuthContext['role']): AuthContext {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    email: 'user@example.com',
    role,
    jwtId: 'session-1',
  };
}

function createResponse(): {
  readonly response: Response;
  readonly status: ReturnType<typeof vi.fn>;
  readonly json: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return {
    response: { status } as unknown as Response,
    status,
    json,
  };
}
